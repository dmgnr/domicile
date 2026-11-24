// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_ENGINE_SURFACE_FRAMES_H_
#define COMPONENTS_DOMICILE_ENGINE_SURFACE_FRAMES_H_

#include <cstddef>
#include <cstdint>
#include <optional>

#include "base/containers/circular_deque.h"
#include "base/containers/flat_map.h"
#include "components/domicile/engine/domicile_engine.h"

namespace domicile {

// Numbers a surface's frames and matches viz's acks and presentation feedback
// to them, for the `frame_done` and `presented` callbacks.
//
// Numbers start at 1 and count every submit, so the compositor counts them
// too.
class SurfaceFrames {
 public:
  // The most frames kept waiting for presentation feedback. Viz reports every
  // frame it is sent, so this only bounds one it never reports.
  static constexpr size_t kMostUnpresented = 64;
  // What Acked returns for a frame sent by Redrawn, which answers nothing.
  static constexpr uint64_t kRedrawn = 0;

  SurfaceFrames();
  SurfaceFrames(const SurfaceFrames&) = delete;
  SurfaceFrames& operator=(const SurfaceFrames&) = delete;
  ~SurfaceFrames();

  // A frame sent to viz as `frame_token`. Returns its number.
  uint64_t Sent(uint32_t frame_token);

  // A frame sent again to show its subsurfaces anew. The compositor did not
  // submit it, so it takes no number and is never reported presented.
  void Redrawn();

  // A frame that never reached viz. Returns its number.
  uint64_t Dropped();

  // Viz acked a frame. Acks name no frame and come in the order frames were
  // sent, so this is the oldest unacked one: kRedrawn for one sent by
  // Redrawn. `nullopt` if none is unacked.
  std::optional<uint64_t> Acked();

  // Viz reported presenting `frame_token`. Returns its number once;
  // `nullopt` for a token this did not send or already reported.
  std::optional<uint64_t> Presented(uint32_t frame_token);

  // Frames sent after the newest one viz reported. Viz reports in the order it
  // draws, so an older frame it never reported is not counted.
  size_t InViz() const;

 private:
  uint64_t last_ = 0;
  // Zero until viz reports a frame. Tokens start at 1.
  uint32_t newest_reported_ = 0;
  base::circular_deque<uint64_t> unacked_;
  base::flat_map<uint32_t, uint64_t> unpresented_;
};

// The DOMICILE_PRESENTED_* flags for a gfx::PresentationFeedback's `flags`.
uint32_t PresentedFlagsOf(uint32_t feedback_flags);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_ENGINE_SURFACE_FRAMES_H_
