// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_REPORTS_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_REPORTS_H_

#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "base/types/expected.h"
#include "base/values.h"

namespace domicile {

// What an app's webContents hears of its page beyond its state, and what the
// app asks of its page's input, sound and user agent, on the Electron socket.
// The rest of the protocol is in electron_protocol.h. The engine says:
//
//   {"type":"console_message","window":1,"level":"warning","message":"m",
//    "line":3,"source":"https://a/app.js"}
//                                          (console-message: debug, info,
//                                           warning or error)
//   {"type":"preload_error","window":1,"name":"TypeError","message":"m",
//    "stack":"..."}                        (preload-error: what the preload
//                                           threw, or a SyntaxError for one
//                                           that did not compile)
//   {"type":"responsive","window":1,"responsive":false}
//                                          (unresponsive, and responsive
//                                           once it answers again)
//   {"type":"html_fullscreen","window":1,"fullscreen":true}
//                                          (enter- and leave-html-full-
//                                           screen)
//   {"type":"media_playing","window":1,"playing":true}
//                                          (media-started-playing, and
//                                           media-paused for false)
//   {"type":"audible","window":1,"audible":true}
//                                          (audio-state-changed)
//   {"type":"favicons","window":1,"urls":["https://a/f.ico"]}
//   {"type":"target_url","window":1,"url":""}
//                                          (update-target-url: the link
//                                           under the pointer, "" for none)
//   {"type":"zoom_asked","window":1,"zoom_in":true}
//                                          (zoom-changed: Ctrl+wheel or a
//                                           pinch the page left alone)
//   {"type":"theme_color","window":1,"color":"#1A2B3C"}
//                                          (did-change-theme-color; no
//                                           "color" for none)
//   {"type":"cursor_changed","window":1,"cursor":"pointer"}
//                                          (cursor-changed, by Electron's
//                                           names; a "custom" one also has
//                                           "image", a PNG data: URL,
//                                           "scale", "width", "height",
//                                           "hotspot_x" and "hotspot_y")
//   {"type":"preferred_size","window":1,"width":300,"height":200}
//                                          (preferred-size-changed, after
//                                           enable_preferred_size_mode)
//   {"type":"content_bounds","window":1,"x":0,"y":0,"width":500,
//    "height":400}                         (content-bounds-updated: the page
//                                           called window.resizeTo, moveTo
//                                           or the like)
//   {"type":"before_input","window":1,"ask":4,"input":{"type":"keyDown",
//    "key":"a","code":"KeyA","is_auto_repeat":false,"is_composing":false,
//    "shift":false,"control":true,"alt":false,"meta":false,"location":0,
//    "modifiers":["control"]}}            (before-input-event, while the app
//                                           listens: the key waits for
//                                           input_answer)
//   {"type":"before_mouse","window":1,"ask":5,"mouse":{"type":"mouseDown",
//    "x":10,"y":20,"button":"left","click_count":1,"global_x":10,
//    "global_y":20,"movement_x":0,"movement_y":0,"modifiers":[]}}
//                                          (before-mouse-event, while the
//                                           app listens: the event waits for
//                                           input_answer)
//   {"type":"input_event","window":1,"event":{"type":"mouseMove",...}}
//                                          (input-event, while the app
//                                           listens: an input event that
//                                           reached the page; a key's has
//                                           "key_code", a mouse event's
//                                           before_mouse's keys, a wheel's
//                                           also "delta_x", "delta_y",
//                                           "wheel_ticks_x",
//                                           "wheel_ticks_y" and
//                                           "has_precise_scrolling_deltas")
//
// and the app asks, each of window `window`'s page:
//
//   {"type":"listen_input","window":1,"keys":true,"mouse":false,
//    "events":false}                      (whether it has before-input-event,
//                                           before-mouse-event and
//                                           input-event listeners)
//   {"type":"input_answer","window":1,"ask":4,"prevent":true}
//                                          (a listener prevented the event,
//                                           or not; answered in the order
//                                           asked)
//   {"type":"send_input_event","window":1,"event":{"type":"keyDown",
//    "key_code":"Enter","modifiers":["shift"]}}
//                                          (webContents.sendInputEvent: a
//                                           key's "key_code"; a mouse
//                                           event's "x", "y", "button",
//                                           "click_count", "global_x",
//                                           "global_y", "movement_x" and
//                                           "movement_y"; a mouseWheel's
//                                           also "delta_x", "delta_y",
//                                           "wheel_ticks_x",
//                                           "wheel_ticks_y",
//                                           "has_precise_scrolling_deltas"
//                                           and "can_scroll". Each but
//                                           "type" may be left out)
//   {"type":"set_audio_muted","window":1,"muted":true}
//   {"type":"set_ignore_menu_shortcuts","window":1,"ignore":true}
//                                          (the shell hears none of the
//                                           keys the page leaves, which run
//                                           the menu bar's accelerators)
//   {"type":"enable_preferred_size_mode","window":1}
//                                          (webPreferences.
//                                           enablePreferredSizeMode)
//   {"type":"set_page_user_agent","window":1,"user_agent":"..."}
//                                          (webContents.setUserAgent: the
//                                           page's own, over its session's,
//                                           from its next navigation on;
//                                           "" for its session's again.
//                                           open_window's "user_agent" sets
//                                           it from the first)

// console-message's level, by Electron's name.
struct ElectronConsoleMessage {
  std::string level;
  std::string message;
  int line = 0;
  std::string source;

  friend bool operator==(const ElectronConsoleMessage&,
                         const ElectronConsoleMessage&) = default;
};

struct ElectronPreloadError {
  std::string name;
  std::string message;
  std::string stack;

  friend bool operator==(const ElectronPreloadError&,
                         const ElectronPreloadError&) = default;
};

struct ElectronResponsive {
  bool responsive = true;

  friend bool operator==(const ElectronResponsive&,
                         const ElectronResponsive&) = default;
};

struct ElectronHtmlFullscreen {
  bool fullscreen = false;

  friend bool operator==(const ElectronHtmlFullscreen&,
                         const ElectronHtmlFullscreen&) = default;
};

struct ElectronMediaPlaying {
  bool playing = false;

  friend bool operator==(const ElectronMediaPlaying&,
                         const ElectronMediaPlaying&) = default;
};

struct ElectronAudible {
  bool audible = false;

  friend bool operator==(const ElectronAudible&,
                         const ElectronAudible&) = default;
};

struct ElectronFavicons {
  std::vector<std::string> urls;

  friend bool operator==(const ElectronFavicons&,
                         const ElectronFavicons&) = default;
};

struct ElectronTargetUrl {
  std::string url;

  friend bool operator==(const ElectronTargetUrl&,
                         const ElectronTargetUrl&) = default;
};

struct ElectronZoomAsked {
  bool zoom_in = false;

  friend bool operator==(const ElectronZoomAsked&,
                         const ElectronZoomAsked&) = default;
};

// A color as "#RRGGBB", Electron's hex, or nothing for none.
struct ElectronThemeColor {
  std::optional<std::string> color;

  friend bool operator==(const ElectronThemeColor&,
                         const ElectronThemeColor&) = default;
};

// The pointer's look over the page, by Electron's name. A "custom" one has
// its picture.
struct ElectronCursor {
  std::string cursor;
  struct Custom {
    // A PNG data: URL.
    std::string image;
    float scale = 1;
    int width = 0;
    int height = 0;
    int hotspot_x = 0;
    int hotspot_y = 0;

    friend bool operator==(const Custom&, const Custom&) = default;
  };
  std::optional<Custom> custom;

  friend bool operator==(const ElectronCursor&,
                         const ElectronCursor&) = default;
};

struct ElectronPreferredSize {
  int width = 0;
  int height = 0;

  friend bool operator==(const ElectronPreferredSize&,
                         const ElectronPreferredSize&) = default;
};

struct ElectronContentBounds {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  friend bool operator==(const ElectronContentBounds&,
                         const ElectronContentBounds&) = default;
};

// A key or mouse event the app sees before the page, which waits for the
// app's input_answer `ask`. `input` is the event, as electron_input.h makes
// it.
struct ElectronBeforeInput {
  int ask = 0;
  base::DictValue input;

  friend bool operator==(const ElectronBeforeInput&,
                         const ElectronBeforeInput&) = default;
};

struct ElectronBeforeMouse {
  int ask = 0;
  base::DictValue mouse;

  friend bool operator==(const ElectronBeforeMouse&,
                         const ElectronBeforeMouse&) = default;
};

// An input event that reached the page, as electron_input.h makes it.
struct ElectronInputEvent {
  base::DictValue event;

  friend bool operator==(const ElectronInputEvent&,
                         const ElectronInputEvent&) = default;
};

using ElectronPageReport = std::variant<ElectronConsoleMessage,
                                        ElectronPreloadError,
                                        ElectronResponsive,
                                        ElectronHtmlFullscreen,
                                        ElectronMediaPlaying,
                                        ElectronAudible,
                                        ElectronFavicons,
                                        ElectronTargetUrl,
                                        ElectronZoomAsked,
                                        ElectronThemeColor,
                                        ElectronCursor,
                                        ElectronPreferredSize,
                                        ElectronContentBounds,
                                        ElectronBeforeInput,
                                        ElectronBeforeMouse,
                                        ElectronInputEvent>;

// The line that says `report` of window `window`'s page, ending in a newline.
std::string ElectronPageReported(int window, const ElectronPageReport& report);

// Which listeners the app has on the page's webContents.
struct ElectronListenInput {
  // before-input-event.
  bool keys = false;
  // before-mouse-event.
  bool mouse = false;
  // input-event.
  bool events = false;

  friend bool operator==(const ElectronListenInput&,
                         const ElectronListenInput&) = default;
};

struct ElectronInputAnswer {
  int ask = 0;
  bool prevent = false;

  friend bool operator==(const ElectronInputAnswer&,
                         const ElectronInputAnswer&) = default;
};

// webContents.sendInputEvent's event, by Electron's names. What a kind of
// event does not have is left at its default.
struct ElectronSyntheticInput {
  // keyDown, keyUp, char, mouseDown, mouseUp, mouseMove, mouseEnter,
  // mouseLeave, contextMenu or mouseWheel.
  std::string type;
  // shift, control, ctrl, alt, meta, command, cmd, iskeypad, isautorepeat,
  // leftbuttondown, middlebuttondown, rightbuttondown, capslock, numlock,
  // left or right, in any case.
  std::vector<std::string> modifiers;
  // A key's, as an accelerator names it: "a", "Enter", "F5", "Space".
  std::string key_code;
  double x = 0;
  double y = 0;
  // Where on the screen; the page's x and y when left out.
  std::optional<double> global_x;
  std::optional<double> global_y;
  double movement_x = 0;
  double movement_y = 0;
  // left, middle or right; left out, a mouseDown's and mouseUp's is left,
  // and the rest have none.
  std::optional<std::string> button;
  int click_count = 1;
  double delta_x = 0;
  double delta_y = 0;
  double wheel_ticks_x = 0;
  double wheel_ticks_y = 0;
  bool has_precise_scrolling_deltas = false;
  bool can_scroll = true;

  friend bool operator==(const ElectronSyntheticInput&,
                         const ElectronSyntheticInput&) = default;
};

// Whether `type` names a keyboard event of sendInputEvent's.
bool IsElectronKeyInput(std::string_view type);

struct ElectronSendInputEvent {
  ElectronSyntheticInput event;

  friend bool operator==(const ElectronSendInputEvent&,
                         const ElectronSendInputEvent&) = default;
};

struct ElectronSetAudioMuted {
  bool muted = false;

  friend bool operator==(const ElectronSetAudioMuted&,
                         const ElectronSetAudioMuted&) = default;
};

struct ElectronSetIgnoreMenuShortcuts {
  bool ignore = false;

  friend bool operator==(const ElectronSetIgnoreMenuShortcuts&,
                         const ElectronSetIgnoreMenuShortcuts&) = default;
};

struct ElectronEnablePreferredSizeMode {
  friend bool operator==(const ElectronEnablePreferredSizeMode&,
                         const ElectronEnablePreferredSizeMode&) = default;
};

// The page's own user agent; empty for its session's.
struct ElectronSetPageUserAgent {
  std::string user_agent;

  friend bool operator==(const ElectronSetPageUserAgent&,
                         const ElectronSetPageUserAgent&) = default;
};

using ElectronPageAction = std::variant<ElectronListenInput,
                                        ElectronInputAnswer,
                                        ElectronSendInputEvent,
                                        ElectronSetAudioMuted,
                                        ElectronSetIgnoreMenuShortcuts,
                                        ElectronEnablePreferredSizeMode,
                                        ElectronSetPageUserAgent>;

// One of the app's asks above of window `window`'s page. `window` is an
// ElectronWindow, which electron_protocol.h, which includes this, names.
struct ElectronPageRequest {
  int window = 0;
  ElectronPageAction action;

  friend bool operator==(const ElectronPageRequest&,
                         const ElectronPageRequest&) = default;
};

// Whether `type` names one of the requests above.
bool IsElectronPageRequest(std::string_view type);

// What `request`, a line of type `type`, asks of its window's page, or why it
// is not a request.
base::expected<ElectronPageAction, std::string> ParseElectronPageAction(
    std::string_view type,
    const base::DictValue& request);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_REPORTS_H_
