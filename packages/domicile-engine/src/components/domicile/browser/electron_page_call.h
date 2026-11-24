// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_CALL_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_CALL_H_

#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "base/types/expected.h"
#include "base/values.h"

namespace domicile {

// A webContents member the engine carries out on an Electron window's page,
// which the app numbers: `page_call`, answered with `page_result` under the
// same number. See "Page calls" in docs/architecture/ELECTRON-APPS.md.
//
//   {"type":"page_call","window":1,"call":4,"method":"insert_css",
//    "css":"a{}","user":false}
//   -> {"type":"page_result","window":1,"call":4,"result":"<key>"}
//   -> {"type":"page_result","window":1,"call":4,"error":"..."}
//
// The methods, with what each takes and gives (null when nothing):
//
//   reload_ignoring_cache                  (webContents.reloadIgnoringCache)
//   insert_css {css, user} -> key          (webContents.insertCSS, in the
//                                           main frame's document: the
//                                           user's sheet when `user`)
//   remove_inserted_css {key, user}        (webContents.removeInsertedCSS)
//   execute_in_isolated_world {world, scripts:[{code, url?}],
//                              user_gesture} -> what the last gave
//                                          (world 0 is the page's own, 999
//                                           the preload's, as in Electron)
//   copy_image_at {x, y}                   (in CSS pixels from the page's
//   copy_video_frame_at {x, y}              top left)
//   adjust_selection {start, end}          (moves the selection's ends by
//                                           characters)
//   set_caret_browsing {enabled}
//   set_webrtc_ip_policy {policy}          (Electron's names: default,
//                                           default_public_interface_only,
//                                           default_public_and_private_
//                                           interfaces,
//                                           disable_non_proxied_udp)
//   set_ignore_input {ignore}              (win.setEnabled(false), and a
//                                           modal's parent)
//   devtools {devtools_method, params} -> its result
//                                          (a DevTools Protocol method the
//                                           host's members need: capture,
//                                           PDF, emulation and screencast,
//                                           on the page's own client, which
//                                           stays attached while the page
//                                           lives; its events come as
//                                           {"type":"devtools_event",
//                                           "window":1,"method":"...",
//                                           "params":{...}})

struct ElectronReloadIgnoringCache {
  friend bool operator==(const ElectronReloadIgnoringCache&,
                         const ElectronReloadIgnoringCache&) = default;
};

struct ElectronInsertCss {
  std::string css;
  bool user = false;
  friend bool operator==(const ElectronInsertCss&,
                         const ElectronInsertCss&) = default;
};

struct ElectronRemoveInsertedCss {
  std::string key;
  bool user = false;
  friend bool operator==(const ElectronRemoveInsertedCss&,
                         const ElectronRemoveInsertedCss&) = default;
};

// One of executeJavaScriptInIsolatedWorld's scripts.
struct ElectronScript {
  std::string code;
  // Where the page's console says it came from; empty for nowhere.
  std::string url;
  friend bool operator==(const ElectronScript&,
                         const ElectronScript&) = default;
};

// Electron's world ids: 0 the page's own world, 999 the preload's, any other
// from 1 a world of the app's.
inline constexpr int kElectronMainWorld = 0;
inline constexpr int kElectronPreloadWorld = 999;
// The most worlds of its own an app numbers: Blink's are counted below
// kEmbedderWorldIdLimit, so the app's are counted in a range of their own.
inline constexpr int kElectronMostWorlds = 1 << 20;

struct ElectronExecuteInIsolatedWorld {
  int world = kElectronMainWorld;
  std::vector<ElectronScript> scripts;
  bool user_gesture = false;
  friend bool operator==(const ElectronExecuteInIsolatedWorld&,
                         const ElectronExecuteInIsolatedWorld&) = default;
};

struct ElectronCopyImageAt {
  int x = 0;
  int y = 0;
  friend bool operator==(const ElectronCopyImageAt&,
                         const ElectronCopyImageAt&) = default;
};

struct ElectronCopyVideoFrameAt {
  int x = 0;
  int y = 0;
  friend bool operator==(const ElectronCopyVideoFrameAt&,
                         const ElectronCopyVideoFrameAt&) = default;
};

struct ElectronAdjustSelection {
  int start = 0;
  int end = 0;
  friend bool operator==(const ElectronAdjustSelection&,
                         const ElectronAdjustSelection&) = default;
};

struct ElectronSetCaretBrowsing {
  bool enabled = false;
  friend bool operator==(const ElectronSetCaretBrowsing&,
                         const ElectronSetCaretBrowsing&) = default;
};

// setWebRTCIPHandlingPolicy's policies, by Electron's names.
enum class ElectronWebRtcIpPolicy {
  kDefault,
  kDefaultPublicInterfaceOnly,
  kDefaultPublicAndPrivateInterfaces,
  kDisableNonProxiedUdp,
};

struct ElectronSetWebRtcIpPolicy {
  ElectronWebRtcIpPolicy policy = ElectronWebRtcIpPolicy::kDefault;
  friend bool operator==(const ElectronSetWebRtcIpPolicy&,
                         const ElectronSetWebRtcIpPolicy&) = default;
};

struct ElectronSetIgnoreInput {
  bool ignore = false;
  friend bool operator==(const ElectronSetIgnoreInput&,
                         const ElectronSetIgnoreInput&) = default;
};

// A DevTools Protocol method for the page's own client.
struct ElectronDevToolsMethod {
  std::string method;
  base::DictValue params;
  friend bool operator==(const ElectronDevToolsMethod&,
                         const ElectronDevToolsMethod&) = default;
};

using ElectronPageMethod = std::variant<ElectronReloadIgnoringCache,
                                        ElectronInsertCss,
                                        ElectronRemoveInsertedCss,
                                        ElectronExecuteInIsolatedWorld,
                                        ElectronCopyImageAt,
                                        ElectronCopyVideoFrameAt,
                                        ElectronAdjustSelection,
                                        ElectronSetCaretBrowsing,
                                        ElectronSetWebRtcIpPolicy,
                                        ElectronSetIgnoreInput,
                                        ElectronDevToolsMethod>;

// Call `call` on window `window`'s page.
struct ElectronPageCall {
  int window = 0;
  int call = 0;
  ElectronPageMethod method;
  friend bool operator==(const ElectronPageCall&,
                         const ElectronPageCall&) = default;
};

// Page method `name` with what it takes from `request`, or why it is none.
base::expected<ElectronPageMethod, std::string> ElectronPageMethodIn(
    std::string_view name,
    base::DictValue& request);

// The answer to window `window`'s page call `call`: what it gave (null for
// nothing), or why it gave nothing.
std::string ElectronPageResult(
    int window,
    int call,
    const base::expected<base::Value, std::string>& result);

// An event of window `window`'s page's DevTools client.
std::string ElectronDevToolsEvent(int window,
                                  std::string_view method,
                                  base::DictValue params);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_PAGE_CALL_H_
