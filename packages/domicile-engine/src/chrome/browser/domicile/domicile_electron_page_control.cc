// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_page_control.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/check.h"
#include "base/containers/flat_map.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/strcat.h"
#include "base/strings/string_view_util.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "components/domicile/mojom/electron_frame.mojom.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "third_party/blink/public/mojom/frame/media_player_action.mojom.h"
#include "third_party/blink/public/mojom/peerconnection/webrtc_ip_handling_policy.mojom.h"
#include "ui/gfx/geometry/point.h"

namespace domicile {
namespace {

blink::mojom::WebRtcIpHandlingPolicy ToBlink(ElectronWebRtcIpPolicy policy) {
  switch (policy) {
    case ElectronWebRtcIpPolicy::kDefault:
      return blink::mojom::WebRtcIpHandlingPolicy::kDefault;
    case ElectronWebRtcIpPolicy::kDefaultPublicInterfaceOnly:
      return blink::mojom::WebRtcIpHandlingPolicy::kDefaultPublicInterfaceOnly;
    case ElectronWebRtcIpPolicy::kDefaultPublicAndPrivateInterfaces:
      return blink::mojom::WebRtcIpHandlingPolicy::
          kDefaultPublicAndPrivateInterfaces;
    case ElectronWebRtcIpPolicy::kDisableNonProxiedUdp:
      return blink::mojom::WebRtcIpHandlingPolicy::kDisableNonProxiedUdp;
  }
}

}  // namespace

// What an app's page calls keep on its page while it lives: its settings,
// the input it ignores, and its DevTools client, attached from its first
// DevTools call. The client stays attached, as an emulation or a screencast
// lasts only while its client does.
class ElectronPageControl final
    : public content::WebContentsUserData<ElectronPageControl>,
      public content::WebContentsObserver,
      public content::DevToolsAgentHostClient {
 public:
  ElectronPageControl(const ElectronPageControl&) = delete;
  ElectronPageControl& operator=(const ElectronPageControl&) = delete;

  ~ElectronPageControl() override {
    if (host_) {
      host_->DetachClient(this);
    }
    FailWaiting("the window's page closed before DevTools answered");
  }

  // The control of `page`, made the first time it is asked for.
  static ElectronPageControl& Of(ElectronPage& page) {
    content::WebContents& contents = *page.web_contents();
    if (FromWebContents(&contents) == nullptr) {
      CreateForWebContents(&contents, page.calls().devtools_event);
    }
    return *FromWebContents(&contents);
  }

  // win.setEnabled: the page takes no input while `ignore`.
  void SetIgnoreInput(bool ignore) {
    if (!ignore) {
      ignoring_.reset();
    } else if (!ignoring_.has_value()) {
      ignoring_.emplace(GetWebContents().IgnoreInputEvents(std::nullopt));
    }
  }

  // webContents.setCaretBrowsingEnabled.
  void SetCaretBrowsing(bool enabled) {
    caret_browsing_ = enabled;
    ApplySettings();
  }

  // webContents.setWebRTCIPHandlingPolicy.
  void SetWebRtcIpPolicy(ElectronWebRtcIpPolicy policy) {
    webrtc_ip_policy_ = policy;
    ApplySettings();
  }

  // content::WebContentsObserver:
  void ReadyToCommitNavigation(content::NavigationHandle* navigation) override {
    // Chrome makes a page's renderer prefs again from the profile's, so the
    // app's settings go back on before each new document of the page's.
    if (navigation->IsInPrimaryMainFrame() && !navigation->IsSameDocument()) {
      ApplySettings();
    }
  }

  // Sends `method` to the page's client, which answers `done`.
  void SendDevTools(ElectronDevToolsMethod method, ElectronAnswer done) {
    if (!host_) {
      scoped_refptr<content::DevToolsAgentHost> host =
          content::DevToolsAgentHost::GetOrCreateFor(&GetWebContents());
      if (!host->AttachClient(this)) {
        std::move(done).Run(
            base::unexpected("DevTools could not attach to the page"));
        return;
      }
      host_ = std::move(host);
    }
    const int id = next_id_++;
    base::DictValue message;
    message.Set("id", id);
    message.Set("method", method.method);
    message.Set("params", std::move(method.params));
    std::optional<std::string> json = base::WriteJson(message);
    // Parsed from the app's JSON, so it writes.
    CHECK(json.has_value());
    waiting_.emplace(id, std::move(done));
    host_->DispatchProtocolMessage(this, base::as_byte_span(*json));
  }

  // content::DevToolsAgentHostClient:
  void DispatchProtocolMessage(content::DevToolsAgentHost* host,
                               base::span<const uint8_t> message) override {
    const std::string_view text = base::as_string_view(message);
    std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(
        text, base::JSON_PARSE_RFC | base::JSON_REPLACE_INVALID_CHARACTERS);
    // DevTools writes its own messages as JSON objects.
    CHECK(parsed.has_value()) << "DevTools sent a message not a JSON object";
    const std::optional<int> id = parsed->FindInt("id");
    if (!id.has_value()) {
      // An event, which DevTools always names; one with no parameters may
      // leave them out.
      std::string* method = parsed->FindString("method");
      base::DictValue* params = parsed->FindDict("params");
      CHECK(method != nullptr) << "DevTools sent an event with no method";
      events_.Run(std::move(*method),
                  params ? std::move(*params) : base::DictValue());
      return;
    }
    auto waiting = waiting_.find(*id);
    // The client sends only the app's methods, each answered once.
    CHECK(waiting != waiting_.end());
    ElectronAnswer done = std::move(waiting->second);
    waiting_.erase(waiting);
    if (const base::DictValue* error = parsed->FindDict("error")) {
      const std::string* why = error->FindString("message");
      std::move(done).Run(base::unexpected(
          why ? *why : std::string("the DevTools method failed")));
    } else {
      base::DictValue* result = parsed->FindDict("result");
      std::move(done).Run(
          base::Value(result ? std::move(*result) : base::DictValue()));
    }
  }

  void AgentHostClosed(content::DevToolsAgentHost* host) override {
    host_ = nullptr;
    FailWaiting("the window's page closed before DevTools answered");
  }

  // The app drives its own page and nothing past it, as Electron's debugger.
  bool MayReadLocalFiles() override { return false; }
  bool MayWriteLocalFiles() override { return false; }
  bool IsTrusted() override { return false; }
  bool AllowUnsafeOperations() override { return false; }

 private:
  friend class content::WebContentsUserData<ElectronPageControl>;

  ElectronPageControl(
      content::WebContents* contents,
      base::RepeatingCallback<void(std::string, base::DictValue)> events)
      : content::WebContentsUserData<ElectronPageControl>(*contents),
        content::WebContentsObserver(contents),
        events_(std::move(events)) {}

  // The app's settings, over what Chrome made of the profile's.
  void ApplySettings() {
    blink::RendererPreferences& prefs =
        *GetWebContents().GetMutableRendererPrefs();
    if (caret_browsing_.has_value()) {
      prefs.caret_browsing_enabled = *caret_browsing_;
    }
    if (webrtc_ip_policy_.has_value()) {
      prefs.webrtc_ip_handling_policy = ToBlink(*webrtc_ip_policy_);
    }
    GetWebContents().SyncRendererPrefs();
  }

  void FailWaiting(const std::string& why) {
    for (auto& [id, done] : std::exchange(waiting_, {})) {
      std::move(done).Run(base::unexpected(why));
    }
  }

  const base::RepeatingCallback<void(std::string, base::DictValue)> events_;
  // The app's settings, once it makes them.
  std::optional<bool> caret_browsing_;
  std::optional<ElectronWebRtcIpPolicy> webrtc_ip_policy_;
  std::optional<content::WebContents::ScopedIgnoreInputEvents> ignoring_;
  // The page's agent while the client is attached to it.
  scoped_refptr<content::DevToolsAgentHost> host_;
  // The app's DevTools methods waiting on their answers, by id.
  base::flat_map<int, ElectronAnswer> waiting_;
  int next_id_ = 1;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ElectronPageControl);

namespace {

// `done` for a renderer's answer of what a script gave: nothing when it threw,
// gave what has no JSON, or its document went first.
base::OnceCallback<void(std::optional<base::Value>)> ScriptAnswer(
    ElectronAnswer done) {
  return mojo::WrapCallbackWithDefaultInvokeIfNotRun(
      base::BindOnce(
          [](ElectronAnswer done, std::optional<base::Value> result) {
            if (result.has_value()) {
              std::move(done).Run(std::move(*result));
            } else {
              // Blink keeps the exception for the page's console.
              std::move(done).Run(base::unexpected(
                  "the script threw, or gave what can't be carried to the "
                  "app, or its document went first; the page's console says "
                  "which"));
            }
          },
          std::move(done)),
      std::optional<base::Value>());
}

}  // namespace

void CallElectronPage(ElectronPage& page,
                      ElectronPageMethod method,
                      ElectronAnswer done) {
  content::WebContents& contents = *page.web_contents();
  mojom::ElectronFrame* frame = page.frame();
  const bool needs_document =
      std::holds_alternative<ElectronInsertCss>(method) ||
      std::holds_alternative<ElectronRemoveInsertedCss>(method) ||
      std::holds_alternative<ElectronExecuteInIsolatedWorld>(method);
  if (needs_document && frame == nullptr) {
    std::move(done).Run(base::unexpected("the page has no document yet"));
  } else if (std::holds_alternative<ElectronReloadIgnoringCache>(method)) {
    // The app asked, so a page after a POST reloads with no warning to
    // cancel it.
    contents.GetController().Reload(content::ReloadType::BYPASSING_CACHE,
                                    /*check_for_repost=*/false);
    std::move(done).Run(base::Value());
  } else if (auto* insert = std::get_if<ElectronInsertCss>(&method)) {
    frame->InsertCSS(
        insert->css, insert->user,
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](ElectronAnswer done, const std::string& key) {
                  if (key.empty()) {
                    std::move(done).Run(base::unexpected(
                        "the page's document went before it took the CSS"));
                  } else {
                    std::move(done).Run(base::Value(key));
                  }
                },
                std::move(done)),
            std::string()));
  } else if (auto* remove = std::get_if<ElectronRemoveInsertedCss>(&method)) {
    frame->RemoveInsertedCSS(remove->key, remove->user);
    std::move(done).Run(base::Value());
  } else if (auto* execute =
                 std::get_if<ElectronExecuteInIsolatedWorld>(&method)) {
    std::vector<mojom::ElectronScriptPtr> scripts;
    for (const ElectronScript& script : execute->scripts) {
      scripts.push_back(mojom::ElectronScript::New(script.code, script.url));
    }
    frame->ExecuteJavaScriptInWorld(execute->world, std::move(scripts),
                                    execute->user_gesture,
                                    ScriptAnswer(std::move(done)));
  } else if (auto* image = std::get_if<ElectronCopyImageAt>(&method)) {
    contents.GetPrimaryMainFrame()->CopyImageAt(image->x, image->y);
    std::move(done).Run(base::Value());
  } else if (auto* video = std::get_if<ElectronCopyVideoFrameAt>(&method)) {
    contents.GetPrimaryMainFrame()->ExecuteMediaPlayerActionAtLocation(
        gfx::Point(video->x, video->y),
        blink::mojom::MediaPlayerAction(
            blink::mojom::MediaPlayerActionType::kCopyVideoFrame,
            /*enable=*/true));
    std::move(done).Run(base::Value());
  } else if (auto* adjust = std::get_if<ElectronAdjustSelection>(&method)) {
    contents.AdjustSelectionByCharacterOffset(adjust->start, adjust->end,
                                              /*show_selection_menu=*/false);
    std::move(done).Run(base::Value());
  } else if (auto* caret = std::get_if<ElectronSetCaretBrowsing>(&method)) {
    ElectronPageControl::Of(page).SetCaretBrowsing(caret->enabled);
    std::move(done).Run(base::Value());
  } else if (auto* webrtc = std::get_if<ElectronSetWebRtcIpPolicy>(&method)) {
    ElectronPageControl::Of(page).SetWebRtcIpPolicy(webrtc->policy);
    std::move(done).Run(base::Value());
  } else if (auto* input = std::get_if<ElectronSetIgnoreInput>(&method)) {
    ElectronPageControl::Of(page).SetIgnoreInput(input->ignore);
    std::move(done).Run(base::Value());
  } else {
    ElectronPageControl::Of(page).SendDevTools(
        std::get<ElectronDevToolsMethod>(std::move(method)), std::move(done));
  }
}

}  // namespace domicile
