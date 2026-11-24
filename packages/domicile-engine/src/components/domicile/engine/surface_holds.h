// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_ENGINE_SURFACE_HOLDS_H_
#define COMPONENTS_DOMICILE_ENGINE_SURFACE_HOLDS_H_

#include <cstdint>
#include <optional>

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "gpu/command_buffer/common/sync_token.h"

namespace domicile {

// Counts viz's holds on a surface's buffers, so a buffer its client destroys
// stays imported until viz is done drawing it: until viz returns it, and its
// GPU has read it.
class SurfaceHolds {
 public:
  // What to do with a buffer viz returned.
  enum class Return {
    // The client still has it: send wl_buffer.release.
    kRelease,
    // The client destroyed it and viz holds none: drop the import.
    kDestroy,
    // The client destroyed it, but viz still holds it from a later frame.
    kKeep,
  };

  SurfaceHolds();
  SurfaceHolds(const SurfaceHolds&) = delete;
  SurfaceHolds& operator=(const SurfaceHolds&) = delete;
  ~SurfaceHolds();

  // A frame showing `buffer` went to viz.
  void Sent(uint64_t buffer);

  // Viz returned `count` holds on `buffer`. Its GPU is done reading it once
  // `read_done` passes. On kDestroy, the import goes after `read_done`.
  Return Returned(uint64_t buffer, int count, const gpu::SyncToken& read_done);

  // The client destroyed `buffer`. When viz holds none of it, the token its
  // import's destruction waits on: the one viz last returned it with, or none
  // if viz never had it. Nullopt while viz holds it.
  std::optional<gpu::SyncToken> Destroyed(uint64_t buffer);

 private:
  base::flat_map<uint64_t, int> held_;
  base::flat_set<uint64_t> destroyed_;
  // The token each returned buffer still alive was last returned with.
  base::flat_map<uint64_t, gpu::SyncToken> read_done_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_ENGINE_SURFACE_HOLDS_H_
