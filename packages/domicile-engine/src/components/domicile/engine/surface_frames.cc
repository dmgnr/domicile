// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_frames.h"

#include <algorithm>
#include <iterator>

#include "ui/gfx/presentation_feedback.h"

namespace domicile {

SurfaceFrames::SurfaceFrames() = default;

SurfaceFrames::~SurfaceFrames() = default;

uint64_t SurfaceFrames::Sent(uint32_t frame_token) {
  const uint64_t number = ++last_;
  unacked_.push_back(number);
  unpresented_[frame_token] = number;
  if (unpresented_.size() > kMostUnpresented) {
    unpresented_.erase(unpresented_.begin());
  }
  return number;
}

void SurfaceFrames::Redrawn() {
  unacked_.push_back(kRedrawn);
}

uint64_t SurfaceFrames::Dropped() {
  return ++last_;
}

std::optional<uint64_t> SurfaceFrames::Acked() {
  if (unacked_.empty()) {
    return std::nullopt;
  }
  const uint64_t number = unacked_.front();
  unacked_.pop_front();
  return number;
}

std::optional<uint64_t> SurfaceFrames::Presented(uint32_t frame_token) {
  newest_reported_ = std::max(newest_reported_, frame_token);
  auto iter = unpresented_.find(frame_token);
  if (iter == unpresented_.end()) {
    return std::nullopt;
  }
  const uint64_t number = iter->second;
  unpresented_.erase(iter);
  return number;
}

size_t SurfaceFrames::InViz() const {
  return static_cast<size_t>(std::distance(
      unpresented_.upper_bound(newest_reported_), unpresented_.end()));
}

uint32_t PresentedFlagsOf(uint32_t feedback_flags) {
  if (feedback_flags & gfx::PresentationFeedback::kFailure) {
    return DOMICILE_PRESENTED_DISCARDED;
  }
  uint32_t flags = 0;
  if (feedback_flags & gfx::PresentationFeedback::kVSync) {
    flags |= DOMICILE_PRESENTED_VSYNC;
  }
  if (feedback_flags & gfx::PresentationFeedback::kHWClock) {
    flags |= DOMICILE_PRESENTED_HW_CLOCK;
  }
  if (feedback_flags & gfx::PresentationFeedback::kHWCompletion) {
    flags |= DOMICILE_PRESENTED_HW_COMPLETION;
  }
  if (feedback_flags & gfx::PresentationFeedback::kZeroCopy) {
    flags |= DOMICILE_PRESENTED_ZERO_COPY;
  }
  return flags;
}

}  // namespace domicile
