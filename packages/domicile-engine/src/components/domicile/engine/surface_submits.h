// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_ENGINE_SURFACE_SUBMITS_H_
#define COMPONENTS_DOMICILE_ENGINE_SURFACE_SUBMITS_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

#include "base/containers/circular_deque.h"
#include "components/domicile/engine/surface_transform.h"
#include "gpu/command_buffer/common/sync_token.h"
#include "ui/gfx/geometry/rect.h"

namespace domicile {

// One wl_surface.commit for the engine to send viz.
struct SurfaceSubmit {
  SurfaceSubmit();
  SurfaceSubmit(const SurfaceSubmit&);
  SurfaceSubmit& operator=(const SurfaceSubmit&);
  ~SurfaceSubmit();

  uint64_t buffer = 0;
  gfx::Rect crop;
  gfx::Rect damage;
  uint64_t box = 0;
  // The synced frame the submit goes up at (common/synced_frame.h).
  uint32_t frame = 0;
  BufferTransform transform = BufferTransform::kNormal;
  // What viz waits on before it samples the buffer: the browser's token for
  // the buffer's acquire fence. Empty for a buffer the compositor finished
  // drawing before it submitted.
  gpu::SyncToken sync_token;
  // The browser refused the acquire fence, so viz must not sample the buffer.
  bool fence_refused = false;
};

// A surface's submits, held in order behind any whose acquire fence the
// browser has not yet put in place.
//
// Viz takes a surface's frames in the order they are sent, and the compositor
// numbers them in the order it submits, so a fenced submit holds back every
// later one.
class SurfaceSubmits {
 public:
  SurfaceSubmits();
  SurfaceSubmits(const SurfaceSubmits&) = delete;
  SurfaceSubmits& operator=(const SurfaceSubmits&) = delete;
  ~SurfaceSubmits();

  // Queues `submit` and returns the submits ready to go, in order: `submit`
  // itself unless an earlier one waits for its fence.
  std::vector<SurfaceSubmit> Push(const SurfaceSubmit& submit);

  // Queues `submit` until its fence is in place. Returns the ticket to pass to
  // Fenced.
  uint64_t Hold(const SurfaceSubmit& submit);

  // The browser put `ticket`'s fence in place behind `sync_token`, or refused
  // it when `sync_token` is nullopt. Returns the submits ready to go, in
  // order. A ticket Hold did not return, or one already fenced, aborts.
  std::vector<SurfaceSubmit> Fenced(
      uint64_t ticket,
      const std::optional<gpu::SyncToken>& sync_token);

  // Whether no submit waits for a fence.
  bool empty() const { return queued_.empty(); }

 private:
  struct Queued {
    Queued();
    Queued(const Queued&);
    Queued& operator=(const Queued&);
    ~Queued();

    // Zero for a submit that waits for nothing.
    uint64_t ticket = 0;
    bool waiting = false;
    SurfaceSubmit submit;
  };

  // Takes the submits at the front that wait for nothing.
  std::vector<SurfaceSubmit> TakeReady();

  base::circular_deque<Queued> queued_;
  uint64_t next_ticket_ = 1;
};

// A surface's newest ready submit, held while viz has too many of the
// surface's frames it has not drawn or discarded.
//
// The sink never asks for BeginFrames and viz acks a frame when it takes it,
// not when it draws, so a client can submit faster than viz draws. Viz aborts
// with more than 25 frames waiting for presentation
// (CompositorFrameSinkSupport::DidPresentCompositorFrame). A newer submit
// replaces the held one: viz would show only the newest at its next draw.
class SurfaceBacklog {
 public:
  // Below viz's 25, with room for the frames sent before a draw's report.
  static constexpr size_t kMostInViz = 16;

  struct Offered {
    Offered();
    Offered(const Offered&);
    Offered& operator=(const Offered&);
    ~Offered();

    // The submit to send now.
    std::optional<SurfaceSubmit> send;
    // The held submit the offered one replaced, which never reaches viz.
    std::optional<SurfaceSubmit> replaced;
  };

  SurfaceBacklog();
  SurfaceBacklog(const SurfaceBacklog&) = delete;
  SurfaceBacklog& operator=(const SurfaceBacklog&) = delete;
  ~SurfaceBacklog();

  // `submit` is ready, and viz has `in_viz` of the surface's frames
  // (SurfaceFrames::InViz). Sends it, or holds it. Either way it replaces any
  // held one.
  Offered Offer(const SurfaceSubmit& submit, size_t in_viz);

  // Viz reported frames and now has `in_viz`. Returns the held submit once
  // there is room for it.
  std::optional<SurfaceSubmit> Take(size_t in_viz);

  // Whether a submit is held.
  bool holding() const { return held_.has_value(); }

 private:
  std::optional<SurfaceSubmit> held_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_ENGINE_SURFACE_SUBMITS_H_
