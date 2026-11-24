// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_submits.h"

#include <cstdint>
#include <optional>
#include <vector>

#include "gpu/command_buffer/common/command_buffer_id.h"
#include "gpu/command_buffer/common/constants.h"
#include "gpu/command_buffer/common/sync_token.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

SurfaceSubmit SubmitOf(uint64_t buffer) {
  SurfaceSubmit submit;
  submit.buffer = buffer;
  return submit;
}

gpu::SyncToken TokenOf(uint64_t release) {
  return gpu::SyncToken(gpu::CommandBufferNamespace::GPU_IO,
                        gpu::CommandBufferId::FromUnsafeValue(1), release);
}

// The buffers of `submits`, in order.
std::vector<uint64_t> BuffersOf(const std::vector<SurfaceSubmit>& submits) {
  std::vector<uint64_t> buffers;
  for (const SurfaceSubmit& submit : submits) {
    buffers.push_back(submit.buffer);
  }
  return buffers;
}

TEST(SurfaceSubmitsTest, ASubmitWithNothingWaitingGoesAtOnce) {
  SurfaceSubmits submits;
  EXPECT_EQ(BuffersOf(submits.Push(SubmitOf(1))), std::vector<uint64_t>{1});
}

// Viz takes frames in the order they are sent, and the compositor numbers
// them in the order it submits.
TEST(SurfaceSubmitsTest, ALaterSubmitWaitsForAnEarlierFence) {
  SurfaceSubmits submits;
  const uint64_t ticket = submits.Hold(SubmitOf(1));
  EXPECT_TRUE(submits.Push(SubmitOf(2)).empty());

  const std::vector<SurfaceSubmit> ready = submits.Fenced(ticket, TokenOf(7));

  EXPECT_EQ(BuffersOf(ready), (std::vector<uint64_t>{1, 2}));
  EXPECT_EQ(ready[0].sync_token, TokenOf(7));
  EXPECT_FALSE(ready[1].sync_token.HasData());
}

// A redraw waits for a frame still on its way, which shows what it would.
TEST(SurfaceSubmitsTest, SubmitsAreQueuedOnlyWhileAFenceIsAwaited) {
  SurfaceSubmits submits;
  submits.Push(SubmitOf(1));
  EXPECT_TRUE(submits.empty());
  const uint64_t ticket = submits.Hold(SubmitOf(2));
  EXPECT_FALSE(submits.empty());
  submits.Fenced(ticket, TokenOf(7));
  EXPECT_TRUE(submits.empty());
}

TEST(SurfaceSubmitsTest, FencesPutInPlaceOutOfOrderGoInOrder) {
  SurfaceSubmits submits;
  const uint64_t first = submits.Hold(SubmitOf(1));
  const uint64_t second = submits.Hold(SubmitOf(2));

  EXPECT_TRUE(submits.Fenced(second, TokenOf(8)).empty());
  const std::vector<SurfaceSubmit> ready = submits.Fenced(first, TokenOf(7));

  EXPECT_EQ(BuffersOf(ready), (std::vector<uint64_t>{1, 2}));
  EXPECT_EQ(ready[0].sync_token, TokenOf(7));
  EXPECT_EQ(ready[1].sync_token, TokenOf(8));
}

// Its buffer may be unfinished, so viz must not sample it.
TEST(SurfaceSubmitsTest, ARefusedFenceComesBackRefused) {
  SurfaceSubmits submits;
  const uint64_t ticket = submits.Hold(SubmitOf(1));

  const std::vector<SurfaceSubmit> ready =
      submits.Fenced(ticket, std::nullopt);

  ASSERT_EQ(BuffersOf(ready), std::vector<uint64_t>{1});
  EXPECT_TRUE(ready[0].fence_refused);
  EXPECT_EQ(BuffersOf(submits.Push(SubmitOf(2))), std::vector<uint64_t>{2});
}

TEST(SurfaceBacklogTest, ASubmitGoesAtOnceWhileVizHasRoom) {
  SurfaceBacklog backlog;
  const SurfaceBacklog::Offered offered =
      backlog.Offer(SubmitOf(1), SurfaceBacklog::kMostInViz - 1);
  ASSERT_TRUE(offered.send.has_value());
  EXPECT_EQ(offered.send->buffer, 1u);
  EXPECT_FALSE(offered.replaced.has_value());
}

// Viz aborts with more than 25 frames waiting to be presented.
TEST(SurfaceBacklogTest, ASubmitWaitsWhileVizIsBehind) {
  SurfaceBacklog backlog;
  const SurfaceBacklog::Offered offered =
      backlog.Offer(SubmitOf(1), SurfaceBacklog::kMostInViz);
  EXPECT_FALSE(offered.send.has_value());
  EXPECT_FALSE(offered.replaced.has_value());
  EXPECT_TRUE(backlog.holding());
  EXPECT_FALSE(backlog.Take(SurfaceBacklog::kMostInViz).has_value());

  const std::optional<SurfaceSubmit> taken =
      backlog.Take(SurfaceBacklog::kMostInViz - 1);
  ASSERT_TRUE(taken.has_value());
  EXPECT_EQ(taken->buffer, 1u);
  EXPECT_FALSE(backlog.holding());
  EXPECT_FALSE(backlog.Take(0).has_value());
}

// Viz would show only the newest at its next draw.
TEST(SurfaceBacklogTest, ANewerSubmitReplacesTheWaitingOne) {
  SurfaceBacklog backlog;
  backlog.Offer(SubmitOf(1), SurfaceBacklog::kMostInViz);
  const SurfaceBacklog::Offered offered =
      backlog.Offer(SubmitOf(2), SurfaceBacklog::kMostInViz);
  EXPECT_FALSE(offered.send.has_value());
  ASSERT_TRUE(offered.replaced.has_value());
  EXPECT_EQ(offered.replaced->buffer, 1u);
  EXPECT_EQ(backlog.Take(0)->buffer, 2u);
}

// Frames go to viz in the order they were submitted, so the older one never
// follows it.
TEST(SurfaceBacklogTest, ASubmitWithRoomGoesInPlaceOfAWaitingOne) {
  SurfaceBacklog backlog;
  backlog.Offer(SubmitOf(1), SurfaceBacklog::kMostInViz);
  const SurfaceBacklog::Offered offered = backlog.Offer(SubmitOf(2), 0);
  EXPECT_EQ(offered.send->buffer, 2u);
  EXPECT_EQ(offered.replaced->buffer, 1u);
  EXPECT_FALSE(backlog.Take(0).has_value());
}

}  // namespace
}  // namespace domicile
