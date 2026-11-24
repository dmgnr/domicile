// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_holds.h"

#include "base/check.h"
#include "base/check_op.h"

namespace domicile {

SurfaceHolds::SurfaceHolds() = default;

SurfaceHolds::~SurfaceHolds() = default;

void SurfaceHolds::Sent(uint64_t buffer) {
  ++held_[buffer];
}

SurfaceHolds::Return SurfaceHolds::Returned(uint64_t buffer,
                                            int count,
                                            const gpu::SyncToken& read_done) {
  auto iter = held_.find(buffer);
  CHECK(iter != held_.end()) << "domicile: viz returned a buffer never sent";
  iter->second -= count;
  CHECK_GE(iter->second, 0) << "domicile: viz returned more than it held";
  if (iter->second == 0) {
    held_.erase(iter);
  }
  if (!destroyed_.contains(buffer)) {
    read_done_[buffer] = read_done;
    return Return::kRelease;
  }
  if (held_.contains(buffer)) {
    return Return::kKeep;
  }
  destroyed_.erase(buffer);
  return Return::kDestroy;
}

std::optional<gpu::SyncToken> SurfaceHolds::Destroyed(uint64_t buffer) {
  if (held_.contains(buffer)) {
    destroyed_.insert(buffer);
    return std::nullopt;
  }
  auto iter = read_done_.find(buffer);
  if (iter == read_done_.end()) {
    return gpu::SyncToken();
  }
  const gpu::SyncToken read_done = iter->second;
  read_done_.erase(iter);
  return read_done;
}

}  // namespace domicile
