// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_UNFOCUSED_WEB_VIEWS_H_
#define COMPONENTS_DOMICILE_BROWSER_UNFOCUSED_WEB_VIEWS_H_

#include <map>
#include <optional>
#include <set>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/time/time.h"
#include "content/public/browser/global_routing_id.h"

namespace domicile {

// Energy Saver's frame rate cap, on the desk's <webview>s only.
//
// Chrome's Energy Saver throttles every frame sink, which on the engine is the
// whole desk: the shell, native windows and every page. Here it throttles only
// the <webview>s other than the one that last took focus. The shell, native
// windows, Electron windows (never added) and the focused page keep their full
// rate. A hidden page draws nothing either way.
//
// Focus moving to the shell or a native window leaves the last focused page at
// full rate.
class UnfocusedWebViews {
 public:
  // Throttles exactly `frames`' frame sinks, and their descendants, to
  // `interval`; an empty set throttles none. content::UpdateThrottlingFrameSinks
  // in the browser.
  using ThrottleFrames = base::RepeatingCallback<void(
      const std::set<content::GlobalRenderFrameHostId>& frames,
      base::TimeDelta interval)>;

  // The browser's, which throttles through content.
  static UnfocusedWebViews& Get();

  explicit UnfocusedWebViews(ThrottleFrames throttle);
  UnfocusedWebViews(const UnfocusedWebViews&) = delete;
  UnfocusedWebViews& operator=(const UnfocusedWebViews&) = delete;
  ~UnfocusedWebViews();

  // Adds `web_view`, whose page's main frame is `main_frame`, or moves it to a
  // new main frame after a navigation.
  void Track(const void* web_view, content::GlobalRenderFrameHostId main_frame);

  // Removes `web_view`, if tracked: it closed, or keeps its full rate.
  void Untrack(const void* web_view);

  // `web_view` took focus, tracked or not. Every other tracked one is
  // unfocused.
  void Focus(const void* web_view);

  // Energy Saver turned on: unfocused <webview>s draw at most once per
  // `interval`.
  void Start(base::TimeDelta interval);

  // Energy Saver turned off: nothing is throttled.
  void Stop();

 private:
  // Throttles the unfocused ones while started.
  void Update();

  ThrottleFrames throttle_;
  std::map<const void*, content::GlobalRenderFrameHostId> main_frames_;
  raw_ptr<const void> focused_ = nullptr;
  std::optional<base::TimeDelta> interval_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_UNFOCUSED_WEB_VIEWS_H_
