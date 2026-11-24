// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_page.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/containers/flat_map.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/electron_downloads.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/domicile/common/electron_node_switches.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/download_item_utils.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/security_principal.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/content_switches.h"
#include "content/public/common/result_codes.h"
#include "content/public/common/stop_find_action.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "sandbox/policy/switches.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_touch_event.h"
#include "third_party/blink/public/common/switches.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "third_party/blink/public/mojom/frame/find_in_page.mojom.h"
#include "ui/gfx/geometry/point_conversions.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// An ElectronAnswer that answers the page: true and the result as JSON, or
// false and why it failed.
ElectronAnswer Answering(
    base::OnceCallback<void(bool, const std::string&)> callback) {
  return base::BindOnce(
      [](base::OnceCallback<void(bool, const std::string&)> callback,
         base::expected<base::Value, std::string> answer) {
        if (!answer.has_value()) {
          std::move(callback).Run(false, answer.error());
          return;
        }
        std::optional<std::string> json = base::WriteJson(*answer);
        // Parsed from the app's JSON, so it writes.
        CHECK(json.has_value());
        std::move(callback).Run(true, *json);
      },
      std::move(callback));
}

// A SiteInstance a Node page's navigation goes into that has no renderer
// yet. By id, so one the navigation dropped leaves nothing dangling.
struct PendingNodeSite {
  content::SiteInstanceId id;
  GURL site_url;
};

// The pending sites, at most a few: a navigation gets its renderer at once.
std::vector<PendingNodeSite>& PendingNodeSites() {
  static base::NoDestructor<std::vector<PendingNodeSite>> pending;
  return *pending;
}
constexpr size_t kMostPendingNodeSites = 16;

// Marks `host`, a renderer a Node page's navigation goes to, to start for
// Node. One that started already, sandboxed, the page's commit then ends.
void MarkForNode(content::RenderProcessHost& host);

// Marks a renderer a Node page's navigation goes to, before it starts.
const char kForNodeKey[] = "domicile-electron-node-pending";
// Marks a renderer started for a Node page.
const char kNodeRendererKey[] = "domicile-electron-node-renderer";

// `frame` as Electron's events name a frame.
ElectronFrame FrameOf(content::RenderFrameHost& frame) {
  return ElectronFrame{.process = frame.GetProcess()->GetDeprecatedID(),
                       .routing = frame.GetRoutingID()};
}

std::optional<ElectronFrame> FrameOf(content::RenderFrameHost* frame) {
  return frame != nullptr ? std::optional<ElectronFrame>(FrameOf(*frame))
                          : std::nullopt;
}

// Whether `navigation` is in the page the window shows, rather than one
// prerendering or a fenced frame's.
bool InShownPage(content::NavigationHandle& navigation) {
  return navigation.IsInMainFrame()
             ? navigation.IsInPrimaryMainFrame()
             : navigation.GetParentFrame()->GetPage().IsPrimary();
}

// `navigation` as Electron's navigation events describe it. Its frame is the
// one it commits in once it has, and the frame's document before.
ElectronNavigation NavigationOf(content::NavigationHandle& navigation) {
  content::RenderFrameHost* frame =
      navigation.HasCommitted()
          ? navigation.GetRenderFrameHost()
          : content::RenderFrameHost::FromID(
                navigation.GetPreviousRenderFrameHostId());
  const std::optional<blink::LocalFrameToken>& initiator =
      navigation.GetInitiatorFrameToken();
  return ElectronNavigation{
      .url = navigation.GetURL(),
      .same_document = navigation.IsSameDocument(),
      .main_frame = navigation.IsInMainFrame(),
      .frame = FrameOf(frame),
      .initiator =
          initiator.has_value()
              ? FrameOf(content::RenderFrameHost::FromFrameToken(
                    content::GlobalRenderFrameHostToken(
                        navigation.GetInitiatorProcessId(), *initiator)))
              : std::nullopt,
  };
}

mojom::ElectronNodePtr ToMojom(const ElectronNode& node) {
  return mojom::ElectronNode::New(node.preload, node.integration,
                                  node.context_isolation, node.app_path,
                                  base::flat_map<std::string, std::string>(
                                      node.env.begin(), node.env.end()));
}

}  // namespace

ElectronPage::ElectronPage(content::WebContents* contents,
                           std::string preload,
                           std::vector<std::string> arguments,
                           std::optional<ElectronNode> node,
                           ElectronPageCalls calls,
                           base::WeakPtr<ElectronSession> session)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<ElectronPage>(*contents),
      preload_(std::move(preload)),
      arguments_(std::move(arguments)),
      node_(std::move(node)),
      calls_(std::move(calls)),
      session_(std::move(session)) {
  // The protocol keeps a Node page's preload in node_->preload.
  CHECK(!node_.has_value() || preload_.empty());
  download_manager_observation_.Observe(
      contents->GetBrowserContext()->GetDownloadManager());
}

ElectronPage::~ElectronPage() = default;

// static
void ElectronPage::Attach(content::WebContents& contents,
                          std::string preload,
                          std::vector<std::string> arguments,
                          std::optional<ElectronNode> node,
                          ElectronPageCalls calls,
                          base::WeakPtr<ElectronSession> session) {
  CHECK(!FromWebContents(&contents));
  CreateForWebContents(&contents, std::move(preload), std::move(arguments),
                       std::move(node), std::move(calls), std::move(session));
}

// static
void ElectronPage::MainFrameNavigatesInto(
    content::RenderFrameHost& frame,
    content::SiteInstance& site_instance) {
  content::WebContents* contents =
      content::WebContents::FromRenderFrameHost(&frame);
  ElectronPage* page = contents ? FromWebContents(contents) : nullptr;
  // A prerendering page has no preload; only the window's own page has Node.
  if (page == nullptr || !page->node_.has_value() ||
      !frame.IsInPrimaryMainFrame()) {
    return;
  }
  if (site_instance.HasProcess()) {
    MarkForNode(*site_instance.GetProcess());
    return;
  }
  std::vector<PendingNodeSite>& pending = PendingNodeSites();
  std::erase_if(pending, [&](const PendingNodeSite& site) {
    return site.id == site_instance.GetId();
  });
  if (pending.size() >= kMostPendingNodeSites) {
    // Navigations that never got a renderer.
    pending.erase(pending.begin());
  }
  pending.push_back(
      {.id = site_instance.GetId(),
       .site_url =
           site_instance.GetSecurityPrincipal().GetDeprecatedSiteURL()});
}

// static
void ElectronPage::SiteInstanceGotProcess(
    content::SiteInstance& site_instance) {
  if (std::erase_if(PendingNodeSites(), [&](const PendingNodeSite& site) {
        return site.id == site_instance.GetId();
      }) > 0) {
    MarkForNode(*site_instance.GetProcess());
  }
}

// static
bool ElectronPage::RefusesSpareRenderer(const GURL& site_url) {
  return std::ranges::any_of(
      PendingNodeSites(),
      [&](const PendingNodeSite& site) { return site.site_url == site_url; });
}

// static
bool ElectronPage::IsSuitableHost(content::RenderProcessHost& host,
                                  const GURL& site_url) {
  return !RefusesSpareRenderer(site_url) || IsForNode(host);
}

namespace {

void MarkForNode(content::RenderProcessHost& host) {
  if (host.IsInitializedAndNotDead() && !ElectronPage::IsNodeRenderer(host)) {
    // Its page commits into a sandboxed renderer, which
    // ReadyToCommitNavigation then ends.
    LOG(ERROR) << "domicile: an Electron page with Node.js navigates into "
                  "renderer "
               << host.GetDeprecatedID()
               << ", which started sandboxed, without Node.js.";
    return;
  }
  if (!host.GetUserData(kForNodeKey)) {
    host.SetUserData(kForNodeKey,
                     std::make_unique<base::SupportsUserData::Data>());
  }
}

}  // namespace

// static
void ElectronPage::AppendRendererSwitches(content::RenderProcessHost& host,
                                          base::CommandLine& command_line) {
  if (!host.GetUserData(kForNodeKey)) {
    return;
  }
  host.SetUserData(kNodeRendererKey,
                   std::make_unique<base::SupportsUserData::Data>());
  command_line.AppendSwitch(sandbox::policy::switches::kNoSandbox);
  command_line.AppendSwitch(switches::kNoZygote);
  command_line.AppendSwitch(kDomicileElectronNodeSwitch);
  const std::string js_flags =
      command_line.GetSwitchValueASCII(blink::switches::kJavaScriptFlags);
  command_line.AppendSwitchASCII(
      blink::switches::kJavaScriptFlags,
      js_flags.empty() ? std::string(kElectronNodeJsFlag)
                       : base::StrCat({js_flags, " ", kElectronNodeJsFlag}));
  LOG(INFO) << "domicile: renderer " << host.GetDeprecatedID()
            << " starts for an Electron page with Node.js, unsandboxed.";
}

// static
bool ElectronPage::IsNodeRenderer(content::RenderProcessHost& host) {
  return host.GetUserData(kNodeRendererKey) != nullptr;
}

// static
bool ElectronPage::IsForNode(content::RenderProcessHost& host) {
  return host.GetUserData(kForNodeKey) != nullptr || IsNodeRenderer(host);
}

bool ElectronPage::HasPreload() const {
  return !preload_.empty() || node_.has_value();
}

// static
base::WeakPtr<ElectronSession> ElectronPage::SessionOf(
    content::WebContents& contents) {
  ElectronPage* page = FromWebContents(&contents);
  if (page == nullptr) {
    return nullptr;
  }
  return page->session_;
}

void ElectronPage::OnDownloadCreated(content::DownloadManager* manager,
                                     download::DownloadItem* item) {
  if (content::DownloadItemUtils::GetWebContents(item) != web_contents() ||
      !session_) {
    return;
  }
  const WebViewGuest* guest = WebViewGuest::FromWebContents(web_contents());
  CHECK(guest) << "domicile: an Electron page is always a <webview>'s";
  MarkElectronDownload(*item, session_, guest->window_id());
}

void ElectronPage::ManagerGoingDown(content::DownloadManager* manager) {
  download_manager_observation_.Reset();
}

void ElectronPage::Deliver(const std::string& channel,
                           const std::string& args_json) {
  // Without a preload there is no ipcRenderer to hear it, as in Electron.
  if (frame_.is_bound()) {
    frame_->Deliver(channel, args_json);
  }
}

void ElectronPage::DeliverPost(const std::string& channel,
                               const std::string& message_json,
                               const std::vector<std::string>& ports) {
  if (frame_.is_bound()) {
    frame_->DeliverPost(channel, message_json, ports);
  }
}

void ElectronPage::DeliverToPort(const std::string& port,
                                 const std::string& data_json) {
  if (frame_.is_bound()) {
    frame_->DeliverToPort(port, data_json);
  }
}

void ElectronPage::ClosePort(const std::string& port) {
  if (frame_.is_bound()) {
    frame_->ClosePort(port);
  }
}

void ElectronPage::MenuClicked(int command) {
  calls_.menu_clicked.Run(command);
}

void ElectronPage::WindowStateChanged(ElectronWindowState state) {
  if (state != window_state_) {
    window_state_ = state;
    calls_.window_state.Run(state);
  }
}

void ElectronPage::CloseAsked() {
  calls_.close_asked.Run();
}

void ElectronPage::GoToIndex(int index) {
  content::NavigationController& controller = web_contents()->GetController();
  if (index < controller.GetEntryCount()) {
    controller.GoToIndex(index);
  }
}

void ElectronPage::ClearHistory() {
  content::NavigationController& controller = web_contents()->GetController();
  if (controller.CanPruneAllButLastCommitted()) {
    controller.PruneAllButLastCommitted();
  }
}

void ElectronPage::RemoveHistoryEntry(int index) {
  content::NavigationController& controller = web_contents()->GetController();
  const bool removed = index < controller.GetEntryCount() &&
                       controller.RemoveEntryAtIndex(index);
  if (!removed) {
    // The history changed after the app last heard it.
    LOG(WARNING) << "domicile: an Electron page's history has no entry "
                 << index << " to remove, or shows it; it stays.";
  }
}

void ElectronPage::DecideFor(WebViewGuest& guest) {
  guest.DecideNavigationsWith(base::BindRepeating(&ElectronPage::AskToNavigate,
                                                  weak_factory_.GetWeakPtr()));
  guest.DecideUnloadsWith(base::BindRepeating(&ElectronPage::AskToUnload,
                                              weak_factory_.GetWeakPtr()));
}

void ElectronPage::AskToNavigate(
    content::NavigationHandle& navigation,
    bool redirect,
    base::OnceCallback<void(bool proceed)> answered) {
  if (!InShownPage(navigation)) {
    std::move(answered).Run(true);
    return;
  }
  // An app that went drops the call: its window closes, and the navigation
  // goes nowhere.
  calls_.will_navigate.Run(
      NavigationOf(navigation), redirect,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(std::move(answered), false));
}

void ElectronPage::AskToUnload(base::OnceCallback<void(bool unload)> answered) {
  // An app that went drops the call: its window closes, and the page with it.
  calls_.will_prevent_unload.Run(
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(std::move(answered), true));
}

void ElectronPage::DidStartNavigation(content::NavigationHandle* navigation) {
  if (InShownPage(*navigation)) {
    calls_.navigation_started.Run(NavigationOf(*navigation));
  }
}

void ElectronPage::DidRedirectNavigation(
    content::NavigationHandle* navigation) {
  if (InShownPage(*navigation)) {
    calls_.navigation_redirected.Run(NavigationOf(*navigation));
  }
}

void ElectronPage::DidFinishNavigation(content::NavigationHandle* navigation) {
  // As Electron: a navigation that committed nothing, as one canceled or
  // replaced, says nothing more.
  if (!navigation->HasCommitted() || !InShownPage(*navigation)) {
    return;
  }
  ElectronNavigation navigated = NavigationOf(*navigation);
  if (navigation->IsErrorPage()) {
    const int error = static_cast<int>(navigation->GetNetErrorCode());
    calls_.load_failed.Run(
        ElectronLoadFailure{.url = std::move(navigated.url),
                            .main_frame = navigated.main_frame,
                            .frame = navigated.frame,
                            .error_code = error,
                            .error_description = net::ErrorToShortString(error),
                            .provisional = true});
    return;
  }
  const net::HttpResponseHeaders* headers = navigation->GetResponseHeaders();
  calls_.navigation_committed.Run(ElectronNavigationCommit{
      .navigation = std::move(navigated),
      .http_response_code = headers ? headers->response_code() : -1,
      .http_status_text = headers ? headers->GetStatusText() : std::string()});
}

void ElectronPage::DidFailLoad(content::RenderFrameHost* frame,
                               const GURL& url,
                               int error_code) {
  if (frame->GetPage().IsPrimary()) {
    calls_.load_failed.Run(ElectronLoadFailure{
        .url = url,
        .main_frame = frame->GetParent() == nullptr,
        .frame = FrameOf(*frame),
        .error_code = error_code,
        .error_description = net::ErrorToShortString(error_code),
        .provisional = false});
  }
}

void ElectronPage::RenderFrameCreated(content::RenderFrameHost* frame) {
  // Not a speculative frame a navigation may yet drop, nor one prerendering.
  if (frame->IsActive()) {
    calls_.frame_created.Run(FrameOf(*frame), frame->GetParent() == nullptr);
  }
}

void ElectronPage::Edit(ElectronEditCommand command) {
  content::WebContents& contents = *web_contents();
  switch (command) {
    case ElectronEditCommand::kUndo:
      contents.Undo();
      return;
    case ElectronEditCommand::kRedo:
      contents.Redo();
      return;
    case ElectronEditCommand::kCut:
      contents.Cut();
      return;
    case ElectronEditCommand::kCopy:
      contents.Copy();
      return;
    case ElectronEditCommand::kPaste:
      contents.Paste();
      return;
    case ElectronEditCommand::kPasteAndMatchStyle:
      contents.PasteAndMatchStyle();
      return;
    case ElectronEditCommand::kDelete:
      contents.Delete();
      return;
    case ElectronEditCommand::kSelectAll:
      contents.SelectAll();
      return;
    case ElectronEditCommand::kUnselect:
      contents.CollapseSelection();
      return;
    case ElectronEditCommand::kCenterSelection:
      contents.CenterSelection();
      return;
  }
}

void ElectronPage::Replace(const std::string& text, bool misspelling) {
  if (misspelling) {
    web_contents()->ReplaceMisspelling(base::UTF8ToUTF16(text));
  } else {
    web_contents()->Replace(base::UTF8ToUTF16(text));
  }
}

void ElectronPage::FindInPage(const ElectronFindInPage& find) {
  auto options = blink::mojom::FindOptions::New();
  options->forward = find.forward;
  options->new_session = !find.find_next;
  options->match_case = find.match_case;
  // The reply can come before Find returns, so the request is known first.
  web_contents()->Find(base::UTF8ToUTF16(find.text), std::move(options),
                       /*skip_delay=*/true, [&](int request_id) {
                         finds_.insert_or_assign(
                             request_id,
                             ElectronFindResult{.request = find.request});
                       });
}

void ElectronPage::StopFindInPage(ElectronStopFindAction action) {
  switch (action) {
    case ElectronStopFindAction::kClearSelection:
      web_contents()->StopFinding(content::STOP_FIND_ACTION_CLEAR_SELECTION);
      return;
    case ElectronStopFindAction::kKeepSelection:
      web_contents()->StopFinding(content::STOP_FIND_ACTION_KEEP_SELECTION);
      return;
    case ElectronStopFindAction::kActivateSelection:
      web_contents()->StopFinding(content::STOP_FIND_ACTION_ACTIVATE_SELECTION);
      return;
  }
}

void ElectronPage::DidReceiveFindReply(int request_id,
                                       int number_of_matches,
                                       const gfx::Rect& selection_rect,
                                       int active_match_ordinal,
                                       bool final_update) {
  const auto find = finds_.find(request_id);
  // Another client's search, as DevTools may run.
  if (find == finds_.end()) {
    return;
  }
  ElectronFindResult& result = find->second;
  // -1 means no change, and an empty rectangle no new selection.
  if (number_of_matches != -1) {
    result.matches = number_of_matches;
  }
  if (active_match_ordinal != -1) {
    result.active_match_ordinal = active_match_ordinal;
  }
  if (!selection_rect.IsEmpty()) {
    result.x = selection_rect.x();
    result.y = selection_rect.y();
    result.width = selection_rect.width();
    result.height = selection_rect.height();
  }
  // Electron says only the last answer, as found-in-page.
  if (final_update) {
    const ElectronFindResult done = result;
    finds_.erase(find);
    calls_.found.Run(done);
  }
}

void ElectronPage::DidGetUserInteraction(const blink::WebInputEvent& event) {
  if (event.GetType() == blink::WebInputEvent::Type::kMouseDown) {
    last_press_ = gfx::ToFlooredPoint(
        static_cast<const blink::WebMouseEvent&>(event).PositionInWidget());
  } else if (event.GetType() == blink::WebInputEvent::Type::kTouchStart) {
    const auto& touch = static_cast<const blink::WebTouchEvent&>(event);
    if (touch.touches_length > 0) {
      last_press_ = gfx::ToFlooredPoint(touch.touches[0].PositionInWidget());
    }
  }
}

void ElectronPage::PrimaryMainFrameWasResized(bool width_changed) {
  ReportSize("PrimaryMainFrameWasResized");
}

void ElectronPage::FrameSizeChanged(content::RenderFrameHost* frame,
                                    const gfx::Size& frame_size) {
  if (frame->IsInPrimaryMainFrame()) {
    ReportSize("FrameSizeChanged");
  }
}

void ElectronPage::PrimaryPageChanged(content::Page& page) {
  ReportSize("PrimaryPageChanged");
  ReportState();
}

void ElectronPage::DidFinishLoad(content::RenderFrameHost* frame,
                                 const GURL& url) {
  if (frame->IsInPrimaryMainFrame()) {
    // The app hears the main frame's load as window_loaded.
    ReportSize("DidFinishLoad");
  } else if (frame->GetParent() != nullptr && frame->IsActive()) {
    calls_.frame_loaded.Run(FrameOf(*frame));
  }
}

void ElectronPage::NavigationEntryCommitted(
    const content::LoadCommittedDetails& details) {
  ReportState();
}

void ElectronPage::NavigationListPruned(
    const content::PrunedDetails& pruned_details) {
  ReportState();
}

void ElectronPage::NavigationEntriesDeleted() {
  ReportState();
}

void ElectronPage::NavigationEntryChanged(
    const content::EntryChangedDetails& change_details) {
  ReportState();
}

void ElectronPage::DidStartLoading() {
  ReportState();
}

void ElectronPage::DidStopLoading() {
  ReportState();
}

void ElectronPage::OnWebContentsFocused(
    content::RenderWidgetHost* render_widget_host) {
  focused_ = true;
  ReportState();
}

void ElectronPage::OnWebContentsLostFocus(
    content::RenderWidgetHost* render_widget_host) {
  focused_ = false;
  ReportState();
}

void ElectronPage::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  ReportState();
}

void ElectronPage::ReportState() {
  content::WebContents& contents = *web_contents();
  content::NavigationController& controller = contents.GetController();
  ElectronPageState state;
  for (int i = 0; i < controller.GetEntryCount(); ++i) {
    const content::NavigationEntry* entry = controller.GetEntryAtIndex(i);
    state.entries.push_back({.url = entry->GetURL().spec(),
                             .title = base::UTF16ToUTF8(entry->GetTitle())});
  }
  // -1 before the first commit, when the history has no entries.
  state.index = std::max(controller.GetCurrentEntryIndex(), 0);
  state.loading = contents.IsLoading();
  state.focused = focused_;
  content::RenderFrameHost* main_frame = contents.GetPrimaryMainFrame();
  content::RenderProcessHost* process = main_frame->GetProcess();
  state.pid = process->GetProcess().IsValid() ? process->GetProcess().Pid() : 0;
  state.crashed = contents.IsCrashed();
  state.process_id = process->GetDeprecatedID();
  state.routing_id = main_frame->GetRoutingID();
  state.frame_token = main_frame->GetFrameToken().ToString();
  state.waiting = contents.IsWaitingForResponse();
  if (state != state_) {
    state_ = state;
    calls_.state.Run(std::move(state));
  }
}

void ElectronPage::ReportSize(std::string_view heard) {
  content::RenderWidgetHostView* view =
      web_contents()->GetRenderWidgetHostView();
  const gfx::Size size = view ? view->GetViewBounds().size() : gfx::Size();
  // Guards read this line. engine-diagnostics.sh greps for the `domicile:`
  // prefix.
  LOG(INFO) << "domicile: an Electron page heard " << heard << ", at "
            << (view ? size.ToString() : std::string("no view"));
  // A view the app hasn't placed has no size yet: nothing to tell.
  if (view != nullptr && !size.IsEmpty() && size != size_) {
    size_ = size;
    calls_.resized.Run(size.width(), size.height());
  }
}

void ElectronPage::ExecuteJavaScript(
    const std::string& code,
    bool user_gesture,
    base::OnceCallback<void(base::expected<base::Value, std::string>)> done) {
  if (!frame_.is_bound()) {
    std::move(done).Run(
        base::unexpected("the page has no document to run it in yet"));
    return;
  }
  frame_->ExecuteJavaScript(
      code, user_gesture,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](base::OnceCallback<void(
                     base::expected<base::Value, std::string>)> done,
                 std::optional<base::Value> result) {
                if (result.has_value()) {
                  std::move(done).Run(std::move(*result));
                } else {
                  // Blink keeps the exception for the page's console.
                  std::move(done).Run(base::unexpected(
                      "the script threw, or gave what can't be carried to "
                      "the app; the page's console says which"));
                }
              },
              std::move(done)),
          std::optional<base::Value>()));
}

void ElectronPage::ReadyToCommitNavigation(
    content::NavigationHandle* navigation) {
  if (!navigation->IsInPrimaryMainFrame() || navigation->IsSameDocument()) {
    return;
  }
  // The document going took its ports and listeners: the app forgets them
  // before the new one's can arrive.
  if (frame_.is_bound() && HasPreload()) {
    calls_.gone.Run();
  }
  // Associated with the frame's channel, as the commit is, so the preload
  // arrives first and the next Deliver or script after. Every document gets
  // one, for the app's scripts; only one the preload runs in hears IPC.
  frame_.reset();
  receiver_.reset();
  navigation->GetRenderFrameHost()
      ->GetRemoteAssociatedInterfaces()
      ->GetInterface(&frame_);
  content::RenderProcessHost* process =
      navigation->GetRenderFrameHost()->GetProcess();
  if (!node_.has_value() && IsNodeRenderer(*process)) {
    // A sandboxed page in a renderer without the sandbox: the engine's bug.
    LOG(ERROR) << "domicile: a sandboxed Electron page is about to commit "
                  "in renderer "
               << process->GetDeprecatedID()
               << ", which was started unsandboxed for Node.js; ending it.";
    process->Shutdown(content::RESULT_CODE_KILLED);
    return;
  }
  LOG(INFO) << "domicile: an Electron page commits in renderer "
            << process->GetDeprecatedID()
            << (node_.has_value() ? " (Node.js)" : " (sandboxed)");
  if (HasPreload() && !navigation->IsErrorPage()) {
    if (node_.has_value() && !IsNodeRenderer(*process)) {
      // Chromium put the page in a renderer started for another, sandboxed
      // and without Node: the engine's bug, and the page would run without
      // what it was written for. Loudly: IsSuitableHost keeps others' renderers
      // from a Node page, so this one should be its own.
      LOG(ERROR) << "domicile: an Electron page with Node.js is about to "
                    "commit in renderer "
                 << process->GetDeprecatedID()
                 << ", which was not started for Node; ending it.";
      process->Shutdown(content::RESULT_CODE_KILLED);
      return;
    }
    if (!session_) {
      // The app is gone, and its windows with it.
      return;
    }
    const ElectronHello& hello = session_->hello();
    frame_->Preload(preload_, arguments_,
                    mojom::ElectronAppFacts::New(hello.electron_version,
                                                 hello.resources_path),
                    node_.has_value() ? ToMojom(*node_) : nullptr,
                    receiver_.BindNewEndpointAndPassRemote());
  }
}

std::optional<base::ListValue> ElectronPage::ArgsFrom(
    const std::string& args_json) {
  std::optional<base::Value> args =
      base::JSONReader::Read(args_json, base::JSON_PARSE_RFC);
  if (!args.has_value() || !args->is_list()) {
    // The preload's bootstrap sends JSON.stringify of an array, always.
    receiver_.ReportBadMessage("ElectronFrameHost: arguments not a JSON array");
    return std::nullopt;
  }
  return std::move(*args).TakeList();
}

void ElectronPage::Send(const std::string& channel,
                        const std::string& args_json) {
  std::optional<base::ListValue> args = ArgsFrom(args_json);
  if (args.has_value()) {
    calls_.sent.Run(channel, std::move(*args));
  }
}

void ElectronPage::Invoke(const std::string& channel,
                          const std::string& args_json,
                          InvokeCallback callback) {
  std::optional<base::ListValue> args = ArgsFrom(args_json);
  if (!args.has_value()) {
    return;
  }
  // An app that goes before it answers drops the answer; the page's promise
  // rejects instead of waiting forever.
  calls_.invoked.Run(channel, std::move(*args),
                     Answering(mojo::WrapCallbackWithDefaultInvokeIfNotRun(
                         std::move(callback), false,
                         std::string("the app's main process is gone"))));
}

void ElectronPage::SendSync(const std::string& channel,
                            const std::string& args_json,
                            SendSyncCallback callback) {
  std::optional<base::ListValue> args = ArgsFrom(args_json);
  if (!args.has_value()) {
    return;
  }
  // The page waits on this, so an app that goes must still answer it.
  calls_.sent_sync.Run(channel, std::move(*args),
                       Answering(mojo::WrapCallbackWithDefaultInvokeIfNotRun(
                           std::move(callback), false,
                           std::string("the app's main process is gone"))));
}

void ElectronPage::Post(const std::string& channel,
                        const std::string& message_json,
                        const std::vector<std::string>& ports) {
  std::optional<base::Value> message = JsonFrom(message_json);
  if (!message.has_value()) {
    return;
  }
  for (auto port = ports.begin(); port != ports.end(); ++port) {
    if (!IsPagePort(*port)) {
      return;
    } else if (std::find(ports.begin(), port, *port) != port) {
      receiver_.ReportBadMessage("ElectronFrameHost: a port posted twice");
      return;
    }
  }
  calls_.posted.Run(channel, std::move(*message), ports);
}

void ElectronPage::PostToPort(const std::string& port,
                              const std::string& data_json) {
  if (!IsPort(port)) {
    return;
  }
  std::optional<base::Value> data = JsonFrom(data_json);
  if (data.has_value()) {
    calls_.port_posted.Run(port, std::move(*data));
  }
}

void ElectronPage::PortClosed(const std::string& port) {
  if (IsPort(port)) {
    calls_.port_closed.Run(port);
  }
}

void ElectronPage::PreloadFailed(const std::string& name,
                                 const std::string& message,
                                 const std::string& stack) {
  calls_.reported.Run(
      ElectronPreloadError{.name = name, .message = message, .stack = stack});
}

std::optional<base::Value> ElectronPage::JsonFrom(const std::string& json) {
  std::optional<base::Value> value =
      base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  if (!value.has_value()) {
    // The preload's bootstrap sends JSON.stringify's, always.
    receiver_.ReportBadMessage("ElectronFrameHost: a message not JSON");
  }
  return value;
}

bool ElectronPage::IsPort(const std::string& port) {
  if (!IsElectronPortName(port)) {
    receiver_.ReportBadMessage("ElectronFrameHost: not a port's name");
    return false;
  }
  return true;
}

bool ElectronPage::IsPagePort(const std::string& port) {
  if (!IsPort(port)) {
    return false;
  } else if (port[0] != 'r') {
    // The page posts the ports it made; the app's are the app's already.
    receiver_.ReportBadMessage("ElectronFrameHost: posted the app's port");
    return false;
  }
  return true;
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(ElectronPage);

}  // namespace domicile
