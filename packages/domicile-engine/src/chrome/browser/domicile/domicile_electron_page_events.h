// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_EVENTS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_EVENTS_H_

#include <deque>
#include <optional>
#include <string>
#include <vector>

#include "base/containers/circular_deque.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "components/domicile/browser/electron_page_reports.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"

namespace domicile {

// What an Electron app's webContents hears of its page and asks of it beyond
// ElectronPage's IPC: its console, sound, fullscreen, icons, cursor and
// input, as electron_page_reports.h lists them. Its main frame's widget is
// the one whose mouse events before-mouse-event holds and input-event hears;
// a key is held in whichever widget has focus.
class ElectronPageEvents final
    : public content::WebContentsObserver,
      public content::WebContentsUserData<ElectronPageEvents>,
      public content::RenderWidgetHost::InputEventObserver,
      public content::RenderWidgetHostObserver,
      public WebViewGuest::AppPage {
 public:
  using Reported = base::RepeatingCallback<void(ElectronPageReport report)>;

  ElectronPageEvents(const ElectronPageEvents&) = delete;
  ElectronPageEvents& operator=(const ElectronPageEvents&) = delete;
  ~ElectronPageEvents() override;

  // Makes `guest`'s page an Electron window's, which reports to its app with
  // `reported`. Before its first navigation.
  static void Attach(WebViewGuest& guest, Reported reported);

  // Does `action`, or says why not. The app does set_page_user_agent itself.
  std::optional<std::string> Ask(ElectronPageAction action);

  // content::WebContentsObserver:
  void OnDidAddMessageToConsole(
      content::RenderFrameHost* source_frame,
      blink::mojom::ConsoleMessageLevel log_level,
      const std::u16string& message,
      int32_t line_no,
      const std::u16string& source_id,
      const std::optional<std::u16string>& untrusted_stack_trace) override;
  void OnRendererUnresponsive(
      content::RenderProcessHost* render_process_host) override;
  void OnRendererResponsive(
      content::RenderProcessHost* render_process_host) override;
  void DidToggleFullscreenModeForTab(bool entered_fullscreen,
                                     bool will_cause_resize) override;
  void MediaStartedPlaying(const MediaPlayerInfo& video_type,
                           const content::MediaPlayerId& id) override;
  void MediaStoppedPlaying(
      const MediaPlayerInfo& video_type,
      const content::MediaPlayerId& id,
      WebContentsObserver::MediaStoppedReason reason) override;
  void OnAudioStateChanged(bool audible) override;
  void DidUpdateFaviconURL(
      content::RenderFrameHost* render_frame_host,
      const std::vector<blink::mojom::FaviconURLPtr>& candidates,
      blink::mojom::FaviconUpdateReason reason) override;
  void DidChangeThemeColor() override;
  // The main frame's widget may be a new one, and a new main frame forgets
  // preferred size mode.
  void RenderFrameCreated(content::RenderFrameHost* render_frame_host) override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;

  // content::RenderWidgetHost::InputEventObserver: input-event.
  void OnInputEvent(const content::RenderWidgetHost& host,
                    const blink::WebInputEvent& event,
                    InputEventSource source) override;

  // content::RenderWidgetHostObserver:
  void RenderWidgetHostDestroyed(
      content::RenderWidgetHost* widget_host) override;

  // WebViewGuest::AppPage:
  void TargetUrlChanged(const GURL& url) override;
  void ZoomAsked(bool zoom_in) override;
  void PreferredSizeChanged(const gfx::Size& size) override;
  void ContentsBoundsAsked(const gfx::Rect& bounds) override;
  void CursorChanged(content::RenderWidgetHost* widget,
                     const ui::Cursor& cursor) override;
  bool HoldsKeyboardEvent(content::RenderWidgetHost* widget,
                          const input::NativeWebKeyboardEvent& event) override;
  bool IgnoresMenuShortcuts() const override;

 private:
  friend class content::WebContentsUserData<ElectronPageEvents>;

  // A widget, as RenderWidgetHost::FromID finds it.
  struct WidgetId {
    int process = 0;
    int routing = 0;
  };
  // A before-input-event or before-mouse-event the app has yet to answer.
  struct Question {
    int ask = 0;
    // A key's widget, which holds it; none for a mouse event, which
    // `held_mice_` holds.
    std::optional<WidgetId> key_widget;
  };
  struct HeldMouse {
    // 0 when the app stopped listening for mouse events.
    int ask = 0;
    blink::WebMouseEvent event;
  };

  ElectronPageEvents(content::WebContents* contents, Reported reported);

  void Report(ElectronPageReport report);
  // Watches the primary main frame's widget, when it is a new one.
  void WatchMainWidget();
  void UnwatchMainWidget();
  // RenderWidgetHost::MouseEventCallback: holds `event` while the app listens
  // for before-mouse-event, or while one ahead of it is held.
  bool HoldsMouseEvent(const blink::WebMouseEvent& event);
  // Sends the held mouse events no question holds back.
  void ReleaseMice();
  void Listen(const ElectronListenInput& listen);
  std::optional<std::string> Answer(const ElectronInputAnswer& answer);
  // Answers `question` as the app's `prevent`.
  void Release(const Question& question, bool prevent);
  std::optional<std::string> Send(const ElectronSyntheticInput& input);
  void UsePreferredSizeMode();

  Reported reported_;

  bool listen_keys_ = false;
  bool listen_mice_ = false;
  bool listen_events_ = false;
  bool ignore_menu_shortcuts_ = false;
  bool preferred_size_mode_ = false;

  int next_ask_ = 1;
  // Oldest first, as the app answers them.
  base::circular_deque<Question> questions_;
  // A std::deque: base::circular_deque memcpys its elements, which a
  // WebMouseEvent, with its vtable, can't be.
  std::deque<HeldMouse> held_mice_;
  // While sending a held mouse event, which the callback lets by.
  bool releasing_mouse_ = false;

  raw_ptr<content::RenderWidgetHost> main_widget_ = nullptr;
  content::RenderWidgetHost::MouseEventCallback mouse_callback_;

  base::WeakPtrFactory<ElectronPageEvents> weak_factory_{this};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_EVENTS_H_
