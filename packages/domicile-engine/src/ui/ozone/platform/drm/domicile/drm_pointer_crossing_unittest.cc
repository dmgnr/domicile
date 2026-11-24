// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_pointer_crossing.h"

#include <optional>
#include <vector>

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/display.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/ozone/public/ozone_platform.h"

namespace ui {
namespace {

constexpr gfx::AcceleratedWidget kLeft = 1;
constexpr gfx::AcceleratedWidget kRight = 2;
constexpr gfx::AcceleratedWidget kLaptop = 3;

// Two 1920x1080 monitors side by side, with no layout, so the engine's
// desktop is used.
std::vector<PointerScreen> SideBySide() {
  return {
      {kLeft, gfx::Rect(0, 0, 1920, 1080), display::Display::ROTATE_0},
      {kRight, gfx::Rect(1920, 0, 1920, 1080), display::Display::ROTATE_0},
  };
}

const std::vector<DomicileDisplayLayout> kHardwareDecides;

// A lit connector: its CRTC's corner on the engine's desktop, and its
// rectangle on the shell's desktop.
DomicileDisplayLayout Lit(const gfx::Point& origin, const gfx::Rect& desk) {
  return {.id = 0, .enabled = true, .origin = origin, .desk = desk};
}

void ExpectAt(const std::optional<PointerCrossing>& crossing,
              gfx::AcceleratedWidget window,
              const gfx::PointF& location) {
  ASSERT_TRUE(crossing.has_value());
  EXPECT_EQ(crossing->window, window);
  EXPECT_NEAR(crossing->location.x(), location.x(), 0.01);
  EXPECT_NEAR(crossing->location.y(), location.y(), 0.01);
}

TEST(DrmPointerCrossingTest, AMoveInsideTheScreenCrossesNothing) {
  EXPECT_FALSE(PointerCrossingFor(SideBySide(), kHardwareDecides, kLeft,
                                  gfx::PointF(1000, 500))
                   .has_value());
}

TEST(DrmPointerCrossingTest, LeavingTheRightEdgeArrivesOnTheScreenBeside) {
  // The overshoot carries over: five pixels past the edge lands five pixels
  // into the next screen, at the same height.
  ExpectAt(PointerCrossingFor(SideBySide(), kHardwareDecides, kLeft,
                              gfx::PointF(1925, 500)),
           kRight, gfx::PointF(5, 500));
}

TEST(DrmPointerCrossingTest, LeavingTheLeftEdgeArrivesOnTheScreenBeside) {
  ExpectAt(PointerCrossingFor(SideBySide(), kHardwareDecides, kRight,
                              gfx::PointF(-5, 500)),
           kLeft, gfx::PointF(1915, 500));
}

TEST(DrmPointerCrossingTest, AnEdgeWithNothingBesideItHoldsThePointer) {
  EXPECT_FALSE(PointerCrossingFor(SideBySide(), kHardwareDecides, kRight,
                                  gfx::PointF(1925, 500))
                   .has_value());
  EXPECT_FALSE(PointerCrossingFor(SideBySide(), kHardwareDecides, kLeft,
                                  gfx::PointF(1000, -5))
                   .has_value());
}

// `home-office-right-two`: the laptop bottom-aligned left of two monitors
// rotated onto their sides. The engine puts the CRTCs in one row; only the
// profile places the laptop at the bottom.
std::vector<PointerScreen> RightTwoScreens() {
  return {
      {kLaptop, gfx::Rect(0, 0, 2880, 1920), display::Display::ROTATE_0},
      {kLeft, gfx::Rect(2880, 0, 3840, 2160), display::Display::ROTATE_270},
      {kRight, gfx::Rect(6720, 0, 3840, 2160), display::Display::ROTATE_270},
  };
}

std::vector<DomicileDisplayLayout> RightTwoLayout() {
  return {
      Lit(gfx::Point(0, 0), gfx::Rect(0, 1920, 1920, 1280)),
      Lit(gfx::Point(2880, 0), gfx::Rect(1920, 0, 1800, 3200)),
      Lit(gfx::Point(6720, 0), gfx::Rect(3720, 0, 1800, 3200)),
  };
}

TEST(DrmPointerCrossingTest, APointerArrivesWhereTheProfilePlacedTheScreens) {
  // Halfway down the laptop is y=2560 on the desk, which is y=3072 on the
  // rotated monitor: upright (6, 3072) on a 2160x3840 screen at `ROTATE_270`.
  ExpectAt(PointerCrossingFor(RightTwoScreens(), RightTwoLayout(), kLaptop,
                              gfx::PointF(2887.5, 960)),
           kLeft, gfx::PointF(3072, 2154));
}

TEST(DrmPointerCrossingTest, AndComesBackTheSameWay) {
  ExpectAt(PointerCrossingFor(RightTwoScreens(), RightTwoLayout(), kLeft,
                              gfx::PointF(3072, 2166)),
           kLaptop, gfx::PointF(2872.5, 960));
}

TEST(DrmPointerCrossingTest, AnEdgeWithNothingPlacedBesideItHoldsThePointer) {
  // Nothing is placed left of the rotated monitor above the laptop.
  EXPECT_FALSE(PointerCrossingFor(RightTwoScreens(), RightTwoLayout(), kLeft,
                                  gfx::PointF(1000, 2166))
                   .has_value());
}

void ExpectNear(const gfx::PointF& actual, const gfx::PointF& expected) {
  EXPECT_NEAR(actual.x(), expected.x(), 0.01);
  EXPECT_NEAR(actual.y(), expected.y(), 0.01);
}

// The host window gets the pointer's desk position, not the engine row's,
// which puts the rotated monitor's pixels right after the laptop's.
TEST(DrmPointerCrossingTest, TheHostHearsThePointerWhereTheDeskHasIt) {
  // The landing point from `APointerArrivesWhereTheProfilePlacedTheScreens`:
  // 7.5 laptop pixels past its right edge, halfway down.
  ExpectNear(PointerInWindow(RightTwoScreens(), RightTwoLayout(),
                             gfx::PointF(2880 + 3072, 2154), kLaptop),
             gfx::PointF(2887.5, 960));
}

TEST(DrmPointerCrossingTest, AndOnATurnedWindowByItsTurnedEdge) {
  // Ten logical pixels onto the right monitor, 1000 down, seen from the left
  // monitor: 12 pixels past its upright right edge, which is above its top on
  // a `ROTATE_270` panel.
  ExpectNear(PointerInWindow(RightTwoScreens(), RightTwoLayout(),
                             gfx::PointF(6720 + 1200, 2148), kLeft),
             gfx::PointF(1200, -12));
}

TEST(DrmPointerCrossingTest, OnItsOwnScreenThePointerIsWhereItIs) {
  ExpectNear(PointerInWindow(RightTwoScreens(), RightTwoLayout(),
                             gfx::PointF(100, 200), kLaptop),
             gfx::PointF(100, 200));
}

// The desk page requests warps in its host window's pixels. A target past
// that window's edge lands on whichever monitor holds it, adjacent or not.
TEST(DrmPointerCrossingTest, AWarpPastTheHostLandsOnTheMonitorThatHoldsIt) {
  // Desk (4620, 1600) is 900 into the right monitor. From the laptop's corner
  // at (0, 1920) at scale 1.5 that is (6930, -480) laptop pixels, and upright
  // (1080, 1920) on the 2160x3840 monitor at `ROTATE_270`.
  ExpectAt(PointerCrossingFor(RightTwoScreens(), RightTwoLayout(), kLaptop,
                              gfx::PointF(6930, -480)),
           kRight, gfx::PointF(1920, 1080));
}

// aura asks where the cursor is to synthesize a move after a window changes,
// and the window that answers is the one that hears the pointer.
TEST(DrmPointerCrossingTest, TheDesksHostHearsThePointerOnEveryMonitor) {
  const std::optional<PointerHeard> heard =
      PointerHeardAt(RightTwoScreens(), RightTwoLayout(), kLaptop,
                     gfx::PointF(2880 + 3072, 2154));
  ASSERT_TRUE(heard.has_value());
  EXPECT_EQ(heard->window, kLaptop);
  ExpectNear(heard->location, gfx::PointF(2887.5, 960));
}

TEST(DrmPointerCrossingTest, WithNoHostTheWindowUnderThePointerHearsIt) {
  const std::optional<PointerHeard> heard = PointerHeardAt(
      SideBySide(), kHardwareDecides, gfx::kNullAcceleratedWidget,
      gfx::PointF(2000, 10));
  ASSERT_TRUE(heard.has_value());
  EXPECT_EQ(heard->window, kRight);
  ExpectNear(heard->location, gfx::PointF(80, 10));
}

// A host whose window closed before the shell named another is not asked:
// `PointerInWindow` CHECKs that its window is a screen.
TEST(DrmPointerCrossingTest, AHostWithNoScreenLeavesItToTheWindowUnderIt) {
  const std::optional<PointerHeard> heard =
      PointerHeardAt(SideBySide(), kHardwareDecides, kLaptop,
                     gfx::PointF(100, 10));
  ASSERT_TRUE(heard.has_value());
  EXPECT_EQ(heard->window, kLeft);
}

// `home-office-center`: the laptop centered under one monitor.
std::vector<PointerScreen> CenterScreens() {
  return {
      {kLeft, gfx::Rect(0, 0, 3840, 2160), display::Display::ROTATE_0},
      {kLaptop, gfx::Rect(3840, 0, 2880, 1920), display::Display::ROTATE_0},
  };
}

std::vector<DomicileDisplayLayout> CenterLayout() {
  return {
      Lit(gfx::Point(0, 0), gfx::Rect(0, 0, 3200, 1800)),
      Lit(gfx::Point(3840, 0), gfx::Rect(640, 1800, 1920, 1280)),
  };
}

TEST(DrmPointerCrossingTest, AScreenBelowIsReachedByTheBottomEdge) {
  ExpectAt(PointerCrossingFor(CenterScreens(), CenterLayout(), kLeft,
                              gfx::PointF(1920, 2166)),
           kLaptop, gfx::PointF(1440, 7.5));
}

TEST(DrmPointerCrossingTest, TheEngineRowSaysNothingAboutWhereAScreenIs) {
  // The laptop's CRTC is right of the monitor's, but the laptop is below.
  EXPECT_FALSE(PointerCrossingFor(CenterScreens(), CenterLayout(), kLeft,
                                  gfx::PointF(3845, 1000))
                   .has_value());
}

TEST(DrmPointerCrossingTest, AScreenTheLayoutLeavesDarkIsNeverEntered) {
  const std::vector<DomicileDisplayLayout> layout = {
      Lit(gfx::Point(0, 0), gfx::Rect(0, 0, 1920, 1080)),
      {.id = 0, .enabled = false, .origin = gfx::Point(1920, 0)},
  };
  EXPECT_FALSE(
      PointerCrossingFor(SideBySide(), layout, kLeft, gfx::PointF(1925, 500))
          .has_value());
}

TEST(DrmPointerCrossingTest, AScreenAPixelAwayIsStillBeside) {
  // Profile positions round outward, so touching screens can be a logical
  // pixel apart. Without tolerance a slow pointer could not cross.
  const std::vector<DomicileDisplayLayout> layout = {
      Lit(gfx::Point(0, 0), gfx::Rect(0, 0, 1920, 1080)),
      Lit(gfx::Point(1920, 0), gfx::Rect(1921, 0, 1920, 1080)),
  };
  ExpectAt(
      PointerCrossingFor(SideBySide(), layout, kLeft, gfx::PointF(1920.5, 500)),
      kRight, gfx::PointF(0, 500));
}

TEST(DrmPointerCrossingTest, TheKeyboardIsOnTheScreenThePointerIsOn) {
  EXPECT_TRUE(
      HasTheKeyboard(gfx::Rect(1920, 0, 1920, 1080), gfx::PointF(1920.5, 500)));
  EXPECT_FALSE(
      HasTheKeyboard(gfx::Rect(0, 0, 1920, 1080), gfx::PointF(1920.5, 500)));
}

TEST(DrmPointerCrossingTest, TheKeyboardEdgeIsTheClickEdge) {
  // Floored like a click's location, so keys and clicks agree on the edge.
  EXPECT_TRUE(
      HasTheKeyboard(gfx::Rect(0, 0, 1920, 1080), gfx::PointF(1919.9, 500)));
}

// Sleeping the host's monitor moves its window onto the monitor the pointer
// is on. The pointer stays put, on the window that now holds its spot.
TEST(DrmPointerCrossingTest, APointerStaysPutWhenItsWindowGoes) {
  const std::vector<PointerScreen> moved = {
      {kLaptop, gfx::Rect(1920, 0, 1920, 1080), display::Display::ROTATE_0},
  };
  ExpectAt(PointerStaysAt(moved, gfx::PointF(2500, 300)), kLaptop,
           gfx::PointF(580, 300));
}

// Waking it moves the host's window back off the pointer's monitor before
// that monitor's own window opens. Nothing holds the spot until then.
TEST(DrmPointerCrossingTest, APointerNoWindowHoldsHasNowhereToStay) {
  const std::vector<PointerScreen> moved = {
      {kLaptop, gfx::Rect(0, 0, 2880, 1920), display::Display::ROTATE_0},
  };
  EXPECT_FALSE(PointerStaysAt(moved, gfx::PointF(3500, 300)).has_value());
}

}  // namespace
}  // namespace ui
