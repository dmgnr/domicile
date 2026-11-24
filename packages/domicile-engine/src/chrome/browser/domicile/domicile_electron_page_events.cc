// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_page_events.h"

#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "base/check.h"
#include "base/check_op.h"
#include "base/functional/bind.h"
#include "base/notreached.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "components/domicile/browser/electron_input.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/mojom/devtools/console_message.mojom-shared.h"
#include "third_party/blink/public/mojom/favicon/favicon_url.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// The visitor of std::visit's lambdas, one per alternative.
template <typename... Lambdas>
struct Overloaded : Lambdas... {
  using Lambdas::operator()...;
};


// console-message's level, by Electron's name.
std::string LevelName(blink::mojom::ConsoleMessageLevel level) {
  switch (level) {
    case blink::mojom::ConsoleMessageLevel::kVerbose:
      return "debug";
    case blink::mojom::ConsoleMessageLevel::kInfo:
      return "info";
    case blink::mojom::ConsoleMessageLevel::kWarning:
      return "warning";
    case blink::mojom::ConsoleMessageLevel::kError:
      return "error";
  }
  NOTREACHED();
}

bool IsHeldKey(const input::NativeWebKeyboardEvent& event) {
  // before-input-event hears key-downs and key-ups, never a Char. A
  // browser's keys go down raw.
  return event.GetType() == blink::WebInputEvent::Type::kRawKeyDown ||
         event.GetType() == blink::WebInputEvent::Type::kKeyUp;
}

}  // namespace

ElectronPageEvents::ElectronPageEvents(content::WebContents* contents,
                                       Reported reported)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<ElectronPageEvents>(*contents),
      reported_(std::move(reported)) {
  mouse_callback_ = base::BindRepeating(&ElectronPageEvents::HoldsMouseEvent,
                                        base::Unretained(this));
  WatchMainWidget();
}

ElectronPageEvents::~ElectronPageEvents() {
  UnwatchMainWidget();
}

// static
void ElectronPageEvents::Attach(WebViewGuest& guest, Reported reported) {
  CHECK(!FromWebContents(&guest.contents()));
  CreateForWebContents(&guest.contents(), std::move(reported));
  guest.ReportToApp(FromWebContents(&guest.contents())->weak_factory_
                        .GetWeakPtr());
}

std::optional<std::string> ElectronPageEvents::Ask(ElectronPageAction action) {
  return std::visit(
      Overloaded{
          [&](const ElectronListenInput& listen) -> std::optional<std::string> {
            Listen(listen);
            return std::nullopt;
          },
          [&](const ElectronInputAnswer& answer) { return Answer(answer); },
          [&](const ElectronSendInputEvent& send) { return Send(send.event); },
          [&](const ElectronSetAudioMuted& mute) -> std::optional<std::string> {
            web_contents()->SetAudioMuted(mute.muted);
            return std::nullopt;
          },
          [&](const ElectronSetIgnoreMenuShortcuts& ignore)
              -> std::optional<std::string> {
            ignore_menu_shortcuts_ = ignore.ignore;
            return std::nullopt;
          },
          [&](const ElectronEnablePreferredSizeMode&)
              -> std::optional<std::string> {
            preferred_size_mode_ = true;
            UsePreferredSizeMode();
            return std::nullopt;
          },
          [&](const ElectronSetPageUserAgent&) -> std::optional<std::string> {
            NOTREACHED() << "ElectronApp sets a page's user agent itself";
          },
      },
      std::move(action));
}

void ElectronPageEvents::OnDidAddMessageToConsole(
    content::RenderFrameHost* source_frame,
    blink::mojom::ConsoleMessageLevel log_level,
    const std::u16string& message,
    int32_t line_no,
    const std::u16string& source_id,
    const std::optional<std::u16string>& untrusted_stack_trace) {
  Report(ElectronConsoleMessage{.level = LevelName(log_level),
                                .message = base::UTF16ToUTF8(message),
                                .line = line_no,
                                .source = base::UTF16ToUTF8(source_id)});
}

void ElectronPageEvents::OnRendererUnresponsive(
    content::RenderProcessHost* render_process_host) {
  Report(ElectronResponsive{.responsive = false});
}

void ElectronPageEvents::OnRendererResponsive(
    content::RenderProcessHost* render_process_host) {
  Report(ElectronResponsive{.responsive = true});
}

void ElectronPageEvents::DidToggleFullscreenModeForTab(bool entered_fullscreen,
                                                       bool will_cause_resize) {
  Report(ElectronHtmlFullscreen{.fullscreen = entered_fullscreen});
}

void ElectronPageEvents::MediaStartedPlaying(const MediaPlayerInfo& video_type,
                                             const content::MediaPlayerId& id) {
  Report(ElectronMediaPlaying{.playing = true});
}

void ElectronPageEvents::MediaStoppedPlaying(
    const MediaPlayerInfo& video_type,
    const content::MediaPlayerId& id,
    WebContentsObserver::MediaStoppedReason reason) {
  Report(ElectronMediaPlaying{.playing = false});
}

void ElectronPageEvents::OnAudioStateChanged(bool audible) {
  Report(ElectronAudible{.audible = audible});
}

void ElectronPageEvents::DidUpdateFaviconURL(
    content::RenderFrameHost* render_frame_host,
    const std::vector<blink::mojom::FaviconURLPtr>& candidates,
    blink::mojom::FaviconUpdateReason reason) {
  ElectronFavicons favicons;
  for (const blink::mojom::FaviconURLPtr& candidate : candidates) {
    if (candidate->icon_type == blink::mojom::FaviconIconType::kFavicon) {
      favicons.urls.push_back(candidate->icon_url.spec());
    }
  }
  Report(std::move(favicons));
}

void ElectronPageEvents::DidChangeThemeColor() {
  const std::optional<SkColor> color = web_contents()->GetThemeColor();
  // Electron's hex: "#RRGGBB".
  Report(ElectronThemeColor{
      .color = color.has_value()
                   ? std::optional(base::StringPrintf(
                         "#%02X%02X%02X", SkColorGetR(*color),
                         SkColorGetG(*color), SkColorGetB(*color)))
                   : std::nullopt});
}

void ElectronPageEvents::RenderFrameCreated(
    content::RenderFrameHost* render_frame_host) {
  if (render_frame_host == web_contents()->GetPrimaryMainFrame()) {
    WatchMainWidget();
    UsePreferredSizeMode();
  }
}

void ElectronPageEvents::RenderFrameHostChanged(
    content::RenderFrameHost* old_host,
    content::RenderFrameHost* new_host) {
  if (new_host != nullptr && new_host->IsInPrimaryMainFrame()) {
    WatchMainWidget();
    UsePreferredSizeMode();
  }
}

void ElectronPageEvents::OnInputEvent(const content::RenderWidgetHost& host,
                                      const blink::WebInputEvent& event,
                                      InputEventSource source) {
  if (listen_events_) {
    Report(ElectronInputEvent{.event = ElectronInputEventValue(event)});
  }
}

void ElectronPageEvents::RenderWidgetHostDestroyed(
    content::RenderWidgetHost* widget_host) {
  CHECK_EQ(widget_host, main_widget_.get());
  UnwatchMainWidget();
}

void ElectronPageEvents::TargetUrlChanged(const GURL& url) {
  Report(ElectronTargetUrl{.url = url.is_valid() ? url.spec() : std::string()});
}

void ElectronPageEvents::ZoomAsked(bool zoom_in) {
  Report(ElectronZoomAsked{.zoom_in = zoom_in});
}

void ElectronPageEvents::PreferredSizeChanged(const gfx::Size& size) {
  Report(ElectronPreferredSize{.width = size.width(), .height = size.height()});
}

void ElectronPageEvents::ContentsBoundsAsked(const gfx::Rect& bounds) {
  Report(ElectronContentBounds{.x = bounds.x(),
                               .y = bounds.y(),
                               .width = bounds.width(),
                               .height = bounds.height()});
}

void ElectronPageEvents::CursorChanged(content::RenderWidgetHost* widget,
                                       const ui::Cursor& cursor) {
  Report(ElectronCursorOf(cursor));
}

bool ElectronPageEvents::HoldsKeyboardEvent(
    content::RenderWidgetHost* widget,
    const input::NativeWebKeyboardEvent& event) {
  if (!listen_keys_ || !IsHeldKey(event)) {
    return false;
  }
  const int ask = next_ask_++;
  questions_.push_back(Question{
      .ask = ask,
      .key_widget = WidgetId{.process = widget->GetProcess()->GetDeprecatedID(),
                             .routing = widget->GetRoutingID()}});
  Report(ElectronBeforeInput{.ask = ask, .input = ElectronKeyInput(event)});
  return true;
}

bool ElectronPageEvents::IgnoresMenuShortcuts() const {
  return ignore_menu_shortcuts_;
}

void ElectronPageEvents::Report(ElectronPageReport report) {
  reported_.Run(std::move(report));
}

void ElectronPageEvents::WatchMainWidget() {
  content::RenderWidgetHost* widget =
      web_contents()->GetPrimaryMainFrame()->GetRenderWidgetHost();
  if (widget == main_widget_) {
    return;
  }
  UnwatchMainWidget();
  main_widget_ = widget;
  main_widget_->AddMouseEventCallback(mouse_callback_);
  main_widget_->AddInputEventObserver(this);
  main_widget_->AddObserver(this);
}

void ElectronPageEvents::UnwatchMainWidget() {
  if (main_widget_ == nullptr) {
    return;
  }
  main_widget_->RemoveMouseEventCallback(mouse_callback_);
  main_widget_->RemoveInputEventObserver(this);
  main_widget_->RemoveObserver(this);
  main_widget_ = nullptr;
  // Their widget is gone, or no longer the page's: the app's answers to
  // them find nothing to send.
  held_mice_.clear();
}

bool ElectronPageEvents::HoldsMouseEvent(const blink::WebMouseEvent& event) {
  if (releasing_mouse_ || (!listen_mice_ && held_mice_.empty())) {
    return false;
  }
  HeldMouse held{.event = event};
  if (listen_mice_) {
    held.ask = next_ask_++;
    questions_.push_back(Question{.ask = held.ask});
    Report(ElectronBeforeMouse{.ask = held.ask,
                               .mouse = ElectronInputEventValue(event)});
  }
  held_mice_.push_back(std::move(held));
  return true;
}

void ElectronPageEvents::ReleaseMice() {
  while (!held_mice_.empty() && held_mice_.front().ask == 0) {
    const blink::WebMouseEvent event = held_mice_.front().event;
    held_mice_.pop_front();
    releasing_mouse_ = true;
    main_widget_->ForwardMouseEvent(event);
    releasing_mouse_ = false;
  }
}

void ElectronPageEvents::Listen(const ElectronListenInput& listen) {
  listen_keys_ = listen.keys;
  listen_mice_ = listen.mouse;
  listen_events_ = listen.events;
  // A listener that left answers nothing: what it held goes on, in order.
  base::circular_deque<Question> asked = std::move(questions_);
  questions_.clear();
  for (const Question& question : asked) {
    const bool still_asked =
        question.key_widget.has_value() ? listen_keys_ : listen_mice_;
    if (still_asked) {
      questions_.push_back(question);
    } else {
      Release(question, /*prevent=*/false);
    }
  }
}

std::optional<std::string> ElectronPageEvents::Answer(
    const ElectronInputAnswer& answer) {
  if (answer.ask >= next_ask_) {
    return base::StrCat({"ask ", base::NumberToString(answer.ask),
                         " is no question the page asked"});
  }
  // An answer to a question a listener that left settled, which the app
  // answered before it heard: nothing waits on it.
  if (questions_.empty() || answer.ask < questions_.front().ask) {
    return std::nullopt;
  }
  if (questions_.front().ask != answer.ask) {
    return base::StrCat({"ask ", base::NumberToString(answer.ask),
                         " is not the page's oldest question"});
  }
  const Question question = questions_.front();
  questions_.pop_front();
  Release(question, answer.prevent);
  return std::nullopt;
}

void ElectronPageEvents::Release(const Question& question, bool prevent) {
  if (question.key_widget.has_value()) {
    // A widget that went took its held keys with it.
    if (content::RenderWidgetHost* widget = content::RenderWidgetHost::FromID(
            question.key_widget->process, question.key_widget->routing)) {
      widget->DomicileReleaseHeldKeyboardEvent(/*send=*/!prevent);
    }
    return;
  }
  // A widget that went took its held mouse events with it.
  if (held_mice_.empty() || held_mice_.front().ask != question.ask) {
    return;
  }
  if (prevent) {
    held_mice_.pop_front();
  } else {
    held_mice_.front().ask = 0;
  }
  ReleaseMice();
}

std::optional<std::string> ElectronPageEvents::Send(
    const ElectronSyntheticInput& input) {
  content::RenderFrameHost* frame = web_contents()->GetPrimaryMainFrame();
  // A page between renderers has no widget to hear it, and Electron sends
  // nothing then either.
  if (!frame->IsRenderFrameLive()) {
    return std::nullopt;
  }
  content::RenderWidgetHost* widget = frame->GetRenderWidgetHost();
  ElectronMadeInput made = ElectronMakeInput(input, base::TimeTicks::Now());
  std::visit(Overloaded{
                 [&](input::NativeWebKeyboardEvent& key) {
                   // Neither the desktop's chords nor the shell's menus
                   // answer a key the app made: only the page.
                   key.skip_if_unhandled = true;
                   widget->ForwardKeyboardEvent(key);
                 },
                 [&](blink::WebMouseEvent& mouse) {
                   widget->ForwardMouseEvent(mouse);
                 },
                 [&](blink::WebMouseWheelEvent& wheel) {
                   widget->ForwardWheelEvent(wheel);
                 },
             },
             made);
  return std::nullopt;
}

void ElectronPageEvents::UsePreferredSizeMode() {
  content::RenderFrameHost* frame = web_contents()->GetPrimaryMainFrame();
  // A frame with no renderer yet gets it in RenderFrameCreated.
  if (preferred_size_mode_ && frame->IsRenderFrameLive()) {
    frame->GetRenderViewHost()->EnablePreferredSizeMode();
  }
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(ElectronPageEvents);

}  // namespace domicile
