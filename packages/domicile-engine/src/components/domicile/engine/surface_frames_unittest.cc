// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_frames.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/presentation_feedback.h"

namespace domicile {
namespace {

// The compositor counts its submits, so every submit takes the next number,
// whether or not it reached viz.
TEST(SurfaceFramesTest, EverySubmitTakesTheNextNumber) {
  SurfaceFrames frames;
  EXPECT_EQ(frames.Sent(/*frame_token=*/7), 1u);
  EXPECT_EQ(frames.Dropped(), 2u);
  EXPECT_EQ(frames.Sent(/*frame_token=*/8), 3u);
}

// Viz's ack names no frame; it acks in the order frames were sent.
TEST(SurfaceFramesTest, AcksMatchFramesInTheOrderTheyWereSent) {
  SurfaceFrames frames;
  frames.Sent(/*frame_token=*/1);
  frames.Dropped();
  frames.Sent(/*frame_token=*/2);
  EXPECT_EQ(frames.Acked(), 1u);
  EXPECT_EQ(frames.Acked(), 3u);
  EXPECT_FALSE(frames.Acked().has_value());
}

// A redraw shows a window's subsurfaces anew. The compositor did not submit
// it, so its ack answers no frame and the numbers carry on past it.
TEST(SurfaceFramesTest, ARedrawIsAckedInTurnButTakesNoNumber) {
  SurfaceFrames frames;
  frames.Sent(/*frame_token=*/1);
  frames.Redrawn();
  EXPECT_EQ(frames.Sent(/*frame_token=*/3), 2u);
  EXPECT_EQ(frames.Acked(), 1u);
  EXPECT_EQ(frames.Acked(), SurfaceFrames::kRedrawn);
  EXPECT_EQ(frames.Acked(), 2u);
}

TEST(SurfaceFramesTest, AFrameIsPresentedOnceByItsToken) {
  SurfaceFrames frames;
  frames.Sent(/*frame_token=*/5);
  frames.Sent(/*frame_token=*/6);
  EXPECT_EQ(frames.Presented(6), 2u);
  EXPECT_FALSE(frames.Presented(6).has_value());
  EXPECT_EQ(frames.Presented(5), 1u);
}

// A frame viz never reports must not keep its entry for the surface's life.
TEST(SurfaceFramesTest, OnlyTheNewestUnpresentedFramesAreKept) {
  SurfaceFrames frames;
  for (uint32_t token = 1; token <= SurfaceFrames::kMostUnpresented + 1;
       ++token) {
    frames.Sent(token);
  }
  EXPECT_FALSE(frames.Presented(1).has_value());
  EXPECT_EQ(frames.Presented(2), 2u);
}

TEST(SurfaceFramesTest, FramesVizHasNotReportedAreInViz) {
  SurfaceFrames frames;
  frames.Sent(/*frame_token=*/1);
  frames.Dropped();
  frames.Sent(/*frame_token=*/2);
  frames.Sent(/*frame_token=*/3);
  EXPECT_EQ(frames.InViz(), 3u);
  frames.Presented(1);
  EXPECT_EQ(frames.InViz(), 2u);
}

// Viz reports frames in the order it draws them, so one it skipped is gone.
TEST(SurfaceFramesTest, AFrameVizNeverReportedLeavesWhenANewerOneIsReported) {
  SurfaceFrames frames;
  frames.Sent(/*frame_token=*/1);
  frames.Sent(/*frame_token=*/2);
  frames.Sent(/*frame_token=*/3);
  frames.Presented(2);
  EXPECT_EQ(frames.InViz(), 1u);
}

// The values are wp_presentation_feedback.kind's, so the compositor passes
// them on unchanged.
TEST(SurfaceFramesTest, FeedbackFlagsBecomeTheAbisFlags) {
  EXPECT_EQ(PresentedFlagsOf(gfx::PresentationFeedback::kVSync |
                             gfx::PresentationFeedback::kHWClock |
                             gfx::PresentationFeedback::kHWCompletion |
                             gfx::PresentationFeedback::kZeroCopy),
            DOMICILE_PRESENTED_VSYNC | DOMICILE_PRESENTED_HW_CLOCK |
                DOMICILE_PRESENTED_HW_COMPLETION |
                DOMICILE_PRESENTED_ZERO_COPY);
  EXPECT_EQ(PresentedFlagsOf(0), 0u);
}

TEST(SurfaceFramesTest, AFailedPresentationIsDiscarded) {
  EXPECT_EQ(PresentedFlagsOf(gfx::PresentationFeedback::kFailure |
                             gfx::PresentationFeedback::kVSync),
            DOMICILE_PRESENTED_DISCARDED);
}

}  // namespace
}  // namespace domicile
