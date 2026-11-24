// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/common/warp_landing.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/point_f.h"

namespace domicile {
namespace {

TEST(WarpLandingTest, TheMoveOntoTheWarpIsTheWarp) {
  WarpLanding landing;
  landing.Warped(gfx::PointF(400, 300));
  // The cursor lands on a whole pixel.
  EXPECT_TRUE(landing.Landed(gfx::PointF(400.4, 299.6)));
}

TEST(WarpLandingTest, OnlyTheFirstMoveThereIsTheWarp) {
  WarpLanding landing;
  landing.Warped(gfx::PointF(400, 300));
  ASSERT_TRUE(landing.Landed(gfx::PointF(400, 300)));
  EXPECT_FALSE(landing.Landed(gfx::PointF(400, 300)));
}

TEST(WarpLandingTest, AMoveElsewhereIsTheMouse) {
  WarpLanding landing;
  landing.Warped(gfx::PointF(400, 300));
  EXPECT_FALSE(landing.Landed(gfx::PointF(401, 300)));
  EXPECT_FALSE(landing.Landed(gfx::PointF(400, 298.5)));
  // And the warp still waits to land.
  EXPECT_TRUE(landing.Landed(gfx::PointF(400, 300)));
}

TEST(WarpLandingTest, NoWarpNoLanding) {
  WarpLanding landing;
  EXPECT_FALSE(landing.Landed(gfx::PointF(0, 0)));
}

}  // namespace
}  // namespace domicile
