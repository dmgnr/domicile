// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_pointer_confinement.h"

#include <optional>
#include <vector>

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/display.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/ozone/public/ozone_platform.h"

namespace ui {
namespace {

constexpr gfx::AcceleratedWidget kLeft = 1;
constexpr gfx::AcceleratedWidget kRight = 2;

// Two 1920x1080 monitors side by side, with no layout, so the engine's
// desktop is used. The left one is the desk's host.
std::vector<PointerScreen> SideBySide() {
  return {
      {kLeft, gfx::Rect(0, 0, 1920, 1080), display::Display::ROTATE_0},
      {kRight, gfx::Rect(1920, 0, 1920, 1080), display::Display::ROTATE_0},
  };
}

const std::vector<DomicileDisplayLayout> kHardwareDecides;

PointerConfinement To(std::vector<gfx::RectF> boxes) {
  return {kLeft, std::move(boxes)};
}

void ExpectAt(const std::optional<PointerCrossing>& crossing,
              gfx::AcceleratedWidget window,
              const gfx::PointF& location) {
  ASSERT_TRUE(crossing.has_value());
  EXPECT_EQ(crossing->window, window);
  EXPECT_NEAR(crossing->location.x(), location.x(), 0.01);
  EXPECT_NEAR(crossing->location.y(), location.y(), 0.01);
}

TEST(DrmPointerConfinementTest, AMoveInsideTheBoxGoesAsItWould) {
  EXPECT_FALSE(ConfinedMove(SideBySide(), kHardwareDecides,
                            To({gfx::RectF(100, 100, 400, 300)}),
                            {kLeft, gfx::PointF(200, 200)},
                            {kLeft, gfx::PointF(450, 350)})
                   .has_value());
}

TEST(DrmPointerConfinementTest, AMoveOutOfTheBoxSlidesAlongItsEdge) {
  // Past the right edge and down: stopped on the last pixel of the box, at
  // the height the move reached.
  ExpectAt(ConfinedMove(SideBySide(), kHardwareDecides,
                        To({gfx::RectF(100, 100, 400, 300)}),
                        {kLeft, gfx::PointF(450, 200)},
                        {kLeft, gfx::PointF(520, 250)}),
           kLeft, gfx::PointF(499, 250));
  ExpectAt(ConfinedMove(SideBySide(), kHardwareDecides,
                        To({gfx::RectF(100, 100, 400, 300)}),
                        {kLeft, gfx::PointF(150, 150)},
                        {kLeft, gfx::PointF(40, 20)}),
           kLeft, gfx::PointF(100, 100));
}

TEST(DrmPointerConfinementTest, ABoxAcrossTheSeamHoldsThePointerOnBothSides) {
  const PointerConfinement across = To({gfx::RectF(1800, 100, 300, 300)});
  // Onto the next monitor, still inside the box: the move goes as it would.
  EXPECT_FALSE(ConfinedMove(SideBySide(), kHardwareDecides, across,
                            {kLeft, gfx::PointF(1900, 200)},
                            {kRight, gfx::PointF(50, 200)})
                   .has_value());
  // Past the box's far edge, which is on the next monitor: stopped there.
  ExpectAt(ConfinedMove(SideBySide(), kHardwareDecides, across,
                        {kRight, gfx::PointF(150, 200)},
                        {kRight, gfx::PointF(400, 200)}),
           kRight, gfx::PointF(179, 200));
  // And back over the seam past its near edge, onto the host's monitor.
  ExpectAt(ConfinedMove(SideBySide(), kHardwareDecides, across,
                        {kRight, gfx::PointF(50, 200)},
                        {kLeft, gfx::PointF(1700, 200)}),
           kLeft, gfx::PointF(1800, 200));
}

TEST(DrmPointerConfinementTest, APointerInNoBoxGoesToTheNearest) {
  ExpectAt(
      ConfinedMove(
          SideBySide(), kHardwareDecides,
          To({gfx::RectF(0, 0, 100, 100), gfx::RectF(1000, 500, 100, 100)}),
          {kLeft, gfx::PointF(900, 450)}, {kLeft, gfx::PointF(905, 455)}),
      kLeft, gfx::PointF(1000, 500));
}

TEST(DrmPointerConfinementTest, AMoveBetweenBoxesOfOneRegionGoes) {
  // Two boxes that touch, as a region with a notch is cut: crossing from one
  // into the other is a move inside the region.
  EXPECT_FALSE(
      ConfinedMove(SideBySide(), kHardwareDecides,
                   To({gfx::RectF(0, 0, 100, 50), gfx::RectF(0, 50, 50, 50)}),
                   {kLeft, gfx::PointF(20, 40)}, {kLeft, gfx::PointF(20, 60)})
          .has_value());
}

TEST(DrmPointerConfinementTest, NoBoxesConfineNothing) {
  EXPECT_FALSE(ConfinedMove(SideBySide(), kHardwareDecides, To({}),
                            {kLeft, gfx::PointF(10, 10)},
                            {kLeft, gfx::PointF(3000, 10)})
                   .has_value());
}

}  // namespace
}  // namespace ui
