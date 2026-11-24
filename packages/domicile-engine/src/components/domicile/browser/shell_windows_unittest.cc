// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_windows.h"

#include <stdint.h>

#include <vector>

#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/display.h"
#include "ui/display/types/display_constants.h"
#include "ui/gfx/geometry/rect.h"

namespace domicile {
namespace {

// A monitor. Only the id matters; the rectangle is there because
// `display::Screen` always reports one.
display::Display Monitor(int64_t id) {
  return display::Display(id, gfx::Rect(0, 0, 1920, 1080));
}

std::vector<int64_t> Ids(const std::vector<display::Display>& displays) {
  std::vector<int64_t> ids;
  for (const display::Display& display : displays) {
    ids.push_back(display.id());
  }
  return ids;
}

TEST(ShellWindowsTest, EveryMonitorOnAColdDeskWantsAWindow) {
  // Windows open in display-list order, so the primary (listed first) opens
  // first.
  const std::vector<display::Display> desk = {Monitor(1), Monitor(2),
                                              Monitor(3)};

  const ShellWindowPlan plan = ShellWindowsFor(desk, {});

  EXPECT_EQ(plan.open, Ids(desk));
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, ADeskThatIsAlreadyRightIsLeftAlone) {
  // Reopening an existing window would reload the shell on every hotplug.
  const std::vector<display::Display> desk = {Monitor(1), Monitor(2)};

  const ShellWindowPlan plan = ShellWindowsFor(desk, {1, 2});

  EXPECT_TRUE(plan.open.empty());
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, AMonitorPluggedInGetsAWindowAndNobodyElseMoves) {
  const ShellWindowPlan plan =
      ShellWindowsFor({Monitor(1), Monitor(2), Monitor(3)}, {1, 3});

  EXPECT_EQ(plan.open, std::vector<int64_t>({2}));
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, AMonitorUnpluggedTakesItsWindowWithIt) {
  // A window with no display wastes a frame sink and a renderer.
  const ShellWindowPlan plan = ShellWindowsFor({Monitor(1)}, {1, 2});

  EXPECT_TRUE(plan.open.empty());
  EXPECT_EQ(plan.close, std::vector<int64_t>({2}));
}

TEST(ShellWindowsTest, OneMonitorSwappedForAnotherTakesItsWindowAlong) {
  // A dock swap arrives as one reading. Moving the window keeps the shell's
  // page; opening a new one would reload it.
  const ShellWindowPlan plan =
      ShellWindowsFor({Monitor(1), Monitor(4)}, {1, 2});

  EXPECT_EQ(plan.move, std::vector<ShellWindowMove>({{.from = 2, .to = 4}}));
  EXPECT_TRUE(plan.open.empty());
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, TheHostMovingTakesItsWindowAlong) {
  // Only the host display is asked for, so sleeping or waking a display can
  // move the host. Reopening the window there would restart the shell.
  const ShellWindowPlan plan = ShellWindowsFor({Monitor(2)}, {1});

  EXPECT_EQ(plan.move, std::vector<ShellWindowMove>({{.from = 1, .to = 2}}));
  EXPECT_TRUE(plan.open.empty());
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, WindowsNoDisplayTakesAreClosedAfterTheMoves) {
  // The first window moves; the rest have nowhere to go.
  const ShellWindowPlan plan = ShellWindowsFor({Monitor(3)}, {1, 2});

  EXPECT_EQ(plan.move, std::vector<ShellWindowMove>({{.from = 1, .to = 3}}));
  EXPECT_TRUE(plan.open.empty());
  EXPECT_EQ(plan.close, std::vector<int64_t>({2}));
}

TEST(ShellWindowsTest, NoDisplaysAtAllStillKeepsOneWindow) {
  // E.g. a laptop lid shut with nothing plugged in. Closing the last window
  // would exit the browser and end the session.
  const ShellWindowPlan plan = ShellWindowsFor({}, {1, 2});

  EXPECT_TRUE(plan.open.empty());
  EXPECT_EQ(plan.close, std::vector<int64_t>({2}));
}

TEST(ShellWindowsTest, AWholeDeskSwappedAtOnceMovesEveryWindow) {
  // Every id is new, so every window moves, in order.
  const ShellWindowPlan plan =
      ShellWindowsFor({Monitor(7), Monitor(8)}, {1, 2});

  EXPECT_EQ(plan.move, std::vector<ShellWindowMove>(
                           {{.from = 1, .to = 7}, {.from = 2, .to = 8}}));
  EXPECT_TRUE(plan.open.empty());
  EXPECT_TRUE(plan.close.empty());
}

TEST(ShellWindowsTest, NothingWindowedAndNothingPluggedInIsNotACrash) {
  // Keeping one window must not assume there is one.
  const ShellWindowPlan plan = ShellWindowsFor({}, {});

  EXPECT_TRUE(plan.open.empty());
  EXPECT_TRUE(plan.close.empty());
}

// A shell window and the display its rectangle reads as on.
SightedShellWindow Seen(uintptr_t window, int64_t nearest) {
  return SightedShellWindow{.window = window, .nearest = nearest};
}

TEST(ShellWindowPlacesTest, AWindowNobodyHasSeenIsWhereItsRectangleIs) {
  // An unplaced window (e.g. the startup one) is recorded at its rectangle.
  ShellWindowPlaces places;

  EXPECT_EQ(places.Update({Seen(1, 100), Seen(2, 200)}, {}),
            std::vector<int64_t>({100, 200}));
}

TEST(ShellWindowPlacesTest, AWindowStaysOnTheDisplayItWasFirstSeenOn) {
  // A hotplug moves display origins before windows are resized, so a window
  // can read as being on another monitor. Reading it fresh would open a
  // duplicate window on one display and leave another dark.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100)}, {});

  EXPECT_EQ(places.Update({Seen(1, 200), Seen(2, 200)}, {}),
            std::vector<int64_t>({100, 200}));
}

TEST(ShellWindowsToFitTest, TheStartupWindowTakesTheDisplayThatReplacedItsOwn) {
  // Ozone headless's placeholder screen goes when the compositor's virtual
  // displays come, and the startup window, first seen after, reads as on the
  // display at its corner while still the placeholder's size.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100)}, {});
  const std::vector<display::Display> desk = {
      display::Display(100, gfx::Rect(0, 0, 640, 480)),
      display::Display(200, gfx::Rect(640, 0, 320, 240))};

  const std::vector<ShellWindowBounds> fit = ShellWindowsToFit(
      places, {{.window = 1, .pixels = gfx::Rect(0, 0, 1024, 768)}}, desk);

  ASSERT_EQ(fit.size(), 1u);
  EXPECT_EQ(fit[0].window, 1u);
  EXPECT_EQ(fit[0].pixels, gfx::Rect(0, 0, 640, 480));
}

TEST(ShellWindowsToFitTest, AWindowAtItsDisplayOrOnNoneIsLeftAlone) {
  // A window on a display that is gone is closed, not fitted.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100), Seen(2, 300)}, {});
  const std::vector<display::Display> desk = {
      display::Display(100, gfx::Rect(0, 0, 640, 480))};

  EXPECT_TRUE(
      ShellWindowsToFit(places,
                        {{.window = 1, .pixels = gfx::Rect(0, 0, 640, 480)},
                         {.window = 2, .pixels = gfx::Rect(0, 0, 1024, 768)}},
                        desk)
          .empty());
}

TEST(ShellWindowPlacesTest, AWindowThatIsGoneIsForgotten) {
  // Window addresses are reused, so a stale record would place the next window
  // on the old display and leave its real display dark.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100)}, {});

  places.Update({}, {});

  EXPECT_EQ(places.Update({Seen(1, 200)}, {}), std::vector<int64_t>({200}));
}

TEST(ShellWindowPlacesTest, AWindowOpenedForADisplayIsOnItBeforeItIsSeen) {
  // A hotplug can happen while a window is opening, so the opener's display
  // wins over the rectangle.
  ShellWindowPlaces places;

  places.Place(1, 100);

  EXPECT_EQ(places.Update({Seen(1, 200)}, {}), std::vector<int64_t>({100}));
}

TEST(ShellWindowPlacesTest, AWindowStillLoadingItsPageKeepsItsPlace) {
  // A window arrives before its shell page commits. Dropping its record then
  // would read the display as bare and open a second window on it.
  ShellWindowPlaces places;
  places.Place(1, 100);

  EXPECT_TRUE(places.Update({}, /*loading=*/{1}).empty());

  EXPECT_EQ(places.Of(1), 100);
  EXPECT_EQ(places.Update({Seen(1, 200)}, {}), std::vector<int64_t>({100}));
}

TEST(ShellWindowPlacesTest, AWindowThatLeftItsShellIsNotStillLoadingIt) {
  // Only the first shell page counts as loading. A shell that navigated away
  // must lose its record, or its monitor stays dark.
  ShellWindowPlaces places;
  places.Place(1, 100);
  places.Update({Seen(1, 100)}, {});

  places.Update({}, /*loading=*/{1});

  EXPECT_EQ(places.Of(1), display::kInvalidDisplayId);
}

TEST(ShellWindowPlacesTest, TheDisplayAWindowIsOnCanBeAskedForOnItsOwn) {
  // Pages name their screen with this, so it must match the reconciliation.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100)}, {});

  EXPECT_EQ(places.Of(1), 100);
  EXPECT_EQ(places.Of(2), display::kInvalidDisplayId);
}

TEST(ShellWindowPlacesTest, AMovedWindowIsOnItsNewDisplay) {
  // The host's window moves when the host does, and must not read as still
  // on the display it left.
  ShellWindowPlaces places;
  places.Update({Seen(1, 100)}, {});

  places.Move(1, 200);

  EXPECT_EQ(places.Update({Seen(1, 100)}, {}), std::vector<int64_t>({200}));
}

}  // namespace
}  // namespace domicile
