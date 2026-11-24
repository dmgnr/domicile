// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/pointer_warp.h"

#include <cmath>
#include <optional>
#include <vector>

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"

namespace domicile {
namespace {

// A shell page offset within its window, so page and window coordinates
// differ.
constexpr gfx::Rect kPage(40, 60, 800, 600);

TEST(PointerWarpTest, APagePointIsThatPointInTheWindow) {
  EXPECT_EQ(PointerWarpTarget(kPage, 100, 200), gfx::Point(140, 260));
}

TEST(PointerWarpTest, AFractionOfAPixelLandsOnTheNearestOne) {
  // The center of an odd-sized window is a half pixel.
  EXPECT_EQ(PointerWarpTarget(kPage, 100.5, 200.5), gfx::Point(141, 261));
}

TEST(PointerWarpTest, APageCannotPutTheCursorOutsideItsOwnWindow) {
  // The browser does not trust the renderer, so a page cannot move the cursor
  // onto another window or monitor.
  EXPECT_EQ(PointerWarpTarget(kPage, -500, 200), gfx::Point(40, 260));
  EXPECT_EQ(PointerWarpTarget(kPage, 10'000, 200), gfx::Point(839, 260));
  EXPECT_EQ(PointerWarpTarget(kPage, 100, 10'000), gfx::Point(140, 659));
}

TEST(PointerWarpTest, TheFarEdgeIsTheLastPixelAndNotThePixelAfterIt) {
  // `right()` is one past the window and may be on another monitor.
  EXPECT_EQ(PointerWarpTarget(kPage, 800, 600), gfx::Point(839, 659));
}

TEST(PointerWarpTest, NothingThatIsNotAPlaceIsOne) {
  // Rounding NaN or infinity to an int is undefined behavior.
  EXPECT_EQ(PointerWarpTarget(kPage, std::nan(""), 200), std::nullopt);
  EXPECT_EQ(PointerWarpTarget(kPage, 100, INFINITY), std::nullopt);
}

TEST(PointerWarpTest, APageWithNoBoxHasNowhereToPutIt) {
  // A window not yet laid out. Clamping would return a corner the page does
  // not occupy.
  EXPECT_EQ(PointerWarpTarget(gfx::Rect(), 0, 0), std::nullopt);
}

// A window's frame in the page, title bar included.
constexpr gfx::RectF kFrame(100, 70, 400, 530);

TEST(PointerWarpTest, APointerOverTheBoxStaysPut) {
  EXPECT_TRUE(PointerAlreadyOver(gfx::PointF(300, 80), kFrame));
}

TEST(PointerWarpTest, EdgesAreInTheBox) {
  // The shell counts its own edges as inside; the two must agree.
  EXPECT_TRUE(PointerAlreadyOver(gfx::PointF(500, 600), kFrame));
  EXPECT_TRUE(PointerAlreadyOver(gfx::PointF(100, 70), kFrame));
}

TEST(PointerWarpTest, APointerElsewhereMoves) {
  EXPECT_FALSE(PointerAlreadyOver(gfx::PointF(501, 300), kFrame));
  EXPECT_FALSE(PointerAlreadyOver(gfx::PointF(300, 69), kFrame));
}

TEST(PointerWarpTest, APointerOffThePageMoves) {
  // The pointer is on no shell, so nothing says it is over the box.
  EXPECT_FALSE(PointerAlreadyOver(std::nullopt, kFrame));
}

void ExpectBoxes(const std::optional<std::vector<gfx::RectF>>& boxes,
                 const std::vector<gfx::RectF>& expected) {
  ASSERT_TRUE(boxes.has_value());
  ASSERT_EQ(boxes->size(), expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ((*boxes)[i].ToString(), expected[i].ToString());
  }
}

TEST(PointerConfinementBoxesTest, APageBoxIsThatBoxInTheWindow) {
  ExpectBoxes(PointerConfinementBoxes(kPage, {gfx::RectF(10, 20, 300, 200)}),
              {gfx::RectF(50, 80, 300, 200)});
}

TEST(PointerConfinementBoxesTest, APageCannotHoldThePointerOutsideItsWindow) {
  // Clipped to the page, and a box wholly off it left out.
  ExpectBoxes(PointerConfinementBoxes(kPage, {gfx::RectF(700, 500, 300, 300),
                                              gfx::RectF(900, 0, 10, 10)}),
              {gfx::RectF(740, 560, 100, 100)});
  EXPECT_FALSE(PointerConfinementBoxes(kPage, {gfx::RectF(-50, -50, 10, 10)})
                   .has_value());
}

TEST(PointerConfinementBoxesTest, NoBoxesLetGo) {
  ExpectBoxes(PointerConfinementBoxes(kPage, {}), {});
}

TEST(PointerConfinementBoxesTest, NothingThatIsNotABoxIsOne) {
  EXPECT_FALSE(
      PointerConfinementBoxes(kPage, {gfx::RectF(NAN, 0, 10, 10)}).has_value());
  EXPECT_FALSE(PointerConfinementBoxes(kPage, {gfx::RectF(0, 0, 10, 10),
                                               gfx::RectF(0, 0, INFINITY, 10)})
                   .has_value());
}

}  // namespace
}  // namespace domicile
