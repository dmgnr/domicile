// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/unfocused_web_views.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "content/public/browser/frame_rate_throttling.h"

namespace domicile {

// static
UnfocusedWebViews& UnfocusedWebViews::Get() {
  static base::NoDestructor<UnfocusedWebViews> web_views(
      base::BindRepeating(&content::UpdateThrottlingFrameSinks));
  return *web_views;
}

UnfocusedWebViews::UnfocusedWebViews(ThrottleFrames throttle)
    : throttle_(std::move(throttle)) {}

UnfocusedWebViews::~UnfocusedWebViews() = default;

void UnfocusedWebViews::Track(const void* web_view,
                              content::GlobalRenderFrameHostId main_frame) {
  main_frames_.insert_or_assign(web_view, main_frame);
  Update();
}

void UnfocusedWebViews::Untrack(const void* web_view) {
  // A later <webview> may take its address.
  if (focused_ == web_view) {
    focused_ = nullptr;
  }
  if (main_frames_.erase(web_view) != 0) {
    Update();
  }
}

void UnfocusedWebViews::Focus(const void* web_view) {
  focused_ = web_view;
  Update();
}

void UnfocusedWebViews::Start(base::TimeDelta interval) {
  interval_ = interval;
  Update();
}

void UnfocusedWebViews::Stop() {
  interval_.reset();
  throttle_.Run({}, base::TimeDelta());
}

void UnfocusedWebViews::Update() {
  if (!interval_.has_value()) {
    return;
  }
  std::set<content::GlobalRenderFrameHostId> unfocused;
  for (const auto& [web_view, main_frame] : main_frames_) {
    if (web_view != focused_) {
      unfocused.insert(main_frame);
    }
  }
  throttle_.Run(unfocused, *interval_);
}

}  // namespace domicile
