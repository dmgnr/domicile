// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHELL_WINDOWS_H_
#define COMPONENTS_DOMICILE_BROWSER_SHELL_WINDOWS_H_

#include <stdint.h>

#include <vector>

#include "base/containers/flat_map.h"
#include "ui/display/display.h"
#include "ui/display/types/display_constants.h"
#include "ui/gfx/geometry/rect.h"

namespace domicile {

// A shell window to move from display `from` to display `to`.
struct ShellWindowMove {
  int64_t from = display::kInvalidDisplayId;
  int64_t to = display::kInvalidDisplayId;

  friend bool operator==(const ShellWindowMove&,
                         const ShellWindowMove&) = default;
};

// Which shell windows to move, open and close so that every display has
// exactly one.
//
// One window cannot span two monitors: `ScreenManager::FindWindowAt` binds a
// window to a display controller only on an exact rectangle match, so a window
// stretched across two CRTCs is scanned out by neither. Monitors come and go,
// so this is recomputed on every hotplug, not only at startup.
struct ShellWindowPlan {
  // Windows whose display is gone, each paired with a display that has none,
  // in order. Moving keeps the shell's page; reopening would reload it and
  // restart the shell.
  std::vector<ShellWindowMove> move;
  // Displays with no window and no window to move there, in display-list
  // order. The primary display comes first (see `PrimaryIndexForLayout` in
  // ui/ozone/platform/drm/domicile/drm_screen.cc), so its window opens first.
  std::vector<int64_t> open;
  // Windows whose display is gone and that no display takes. Such a window
  // holds a frame sink and a renderer nobody sees, and can hold the shell's
  // keyboard focus.
  //
  // Never all of them: closing the last browser window exits the browser and
  // ends the session. With no display left, one window is kept until a display
  // returns.
  std::vector<int64_t> close;
};

// `displays` is what `display::Screen` reports now; `windowed` is the display
// of each existing shell window.
//
// A display that already has a window keeps it, and a window whose display
// is gone moves to one that has none. Reopening would reload the shell and
// reset every embedded page on each hotplug, and on each sleep or wake that
// moves the host.
//
// A display whose bounds changed is not reported. Its window stays, and the
// caller must resize it to the new bounds, or the exact-rect match fails and
// the screen goes black.
//
// The caller must open windows before closing them, so the browser never
// passes through zero windows and exits.
ShellWindowPlan ShellWindowsFor(const std::vector<display::Display>& displays,
                                const std::vector<int64_t>& windowed);

// One existing shell window and the display its rectangle is nearest to.
//
// `window` is the browser's window pointer, stored as a number so it is only
// used as an identity and never dereferenced.
struct SightedShellWindow {
  uintptr_t window = 0;
  int64_t nearest = display::kInvalidDisplayId;
};

// Which display each shell window is on: the one it was first seen on, not the
// one its rectangle reads as now.
//
// A hotplug moves display origins before the windows are resized, so a window
// at its old rectangle can read as being on another monitor. That would make
// `ShellWindowsFor` open a duplicate on one display and leave another dark.
// A window only changes display through `Move`, so the first sighting stays
// correct otherwise.
//
// Records are re-derived from the browser's live windows on every read, since
// a window can close on its own (e.g. a crashed renderer). A stale record would
// mark its display as covered and leave it dark.
class ShellWindowPlaces {
 public:
  ShellWindowPlaces();

  ShellWindowPlaces(const ShellWindowPlaces&) = delete;
  ShellWindowPlaces& operator=(const ShellWindowPlaces&) = delete;

  ~ShellWindowPlaces();

  // Records that `window` was opened for `display`, before any `Update` sees
  // it. Windows open asynchronously, and a hotplug in that gap makes the
  // rectangle unreliable.
  void Place(uintptr_t window, int64_t display);

  // Records that `window` moved to `display`. Unlike `Place`, the window
  // keeps its shell page, so it is not loading one.
  void Move(uintptr_t window, int64_t display);

  // The display of each window in `live`, in order; this is the `windowed`
  // input to `ShellWindowsFor`. A window seen for the first time is recorded
  // at its rectangle's display.
  //
  // `loading` is every other browser window, with no shell page committed yet.
  // A `Place`d window still loading its first shell page keeps its record, so
  // its display is not read as bare and given a second window. Every other
  // record for a window not in `live` is dropped.
  std::vector<int64_t> Update(const std::vector<SightedShellWindow>& live,
                              const std::vector<uintptr_t>& loading);

  // The display `window` is on, or `display::kInvalidDisplayId` if it was
  // neither `Place`d nor seen by `Update`. Pages use this to name their screen,
  // so it must match what the reconciliation uses.
  int64_t Of(uintptr_t window) const;

 private:
  struct Record {
    int64_t display = display::kInvalidDisplayId;
    // Whether an `Update` has seen it in `live`. Until then it is loading its
    // first shell page and is kept even when absent from `live`.
    bool seen = false;
  };

  base::flat_map<uintptr_t, Record> placed_;
};

// A shell window and its rectangle, in pixels.
struct ShellWindowBounds {
  uintptr_t window = 0;
  gfx::Rect pixels;
};

// Each window in `windows` that `places` puts on one of `displays` but is not
// at that display's rectangle, with the rectangle it must take.
//
// A window `ShellWindowPlaces` first sees at its rectangle's display, as the
// startup window is, was never opened to fit it. On ozone headless that
// window is the placeholder screen's size when the compositor's virtual
// displays replace that screen, and a display capture finds no window at the
// display's rectangle.
std::vector<ShellWindowBounds> ShellWindowsToFit(
    const ShellWindowPlaces& places,
    const std::vector<ShellWindowBounds>& windows,
    const std::vector<display::Display>& displays);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHELL_WINDOWS_H_
