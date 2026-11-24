// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CROSSING_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CROSSING_H_

#include <optional>
#include <vector>

#include "ui/display/display.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/ozone/public/ozone_platform.h"

namespace ui {

// One window a pointer can be on, as `DrmCursor` tracks it.
struct PointerScreen {
  gfx::AcceleratedWidget window = gfx::kNullAcceleratedWidget;
  // The CRTC's rectangle on the engine's desktop, in pixels.
  gfx::Rect bounds_in_screen;
  // The monitor's rotation. `CursorController` rotates pointer motion on
  // this window by it.
  display::Display::Rotation rotation = display::Display::ROTATE_0;
};

// Where a pointer that left its screen arrives.
struct PointerCrossing {
  gfx::AcceleratedWidget window = gfx::kNullAcceleratedWidget;
  // In that window's panel pixels, unclamped.
  gfx::PointF location;
};

// Returns the screen a pointer moved to `location` crosses onto, if any.
//
// - views has no ash `ExtendedMouseWarpController`, so the engine moves the
//   pointer between CRTC windows. Shells see one desk.
// - `from` is the pointer's window. `location` is in its panel pixels,
//   unclamped, or a host-requested warp target anywhere on the desk.
// - Crossings use the `layout` desk rectangles, not the engine's CRTC row.
//   The pointer leaves by any edge onto the screen placed there, as in sway.
//   Dark connectors are never entered. An empty layout uses the engine's
//   desktop.
// - Edges are judged upright, then mapped back to the target's panel pixels.
//
// See docs/DISPLAYS.md#pointer-crossing.
std::optional<PointerCrossing> PointerCrossingFor(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    gfx::AcceleratedWidget from,
    const gfx::PointF& location);

// Returns a pointer at `location` on the engine's desktop in `window`'s panel
// pixels, as the desk's host should receive it.
//
// - The host window gets desk-relative positions from every monitor, using
//   the layout's placement, rotation and scale. Upstream uses the CRTC row.
// - Unclamped, so the host sees positions past its edge.
// - Falls back to upstream's arithmetic on `window` itself, or when the
//   layout does not place either screen.
gfx::PointF PointerInWindow(const std::vector<PointerScreen>& screens,
                            const std::vector<DomicileDisplayLayout>& layout,
                            const gfx::PointF& location,
                            gfx::AcceleratedWidget window);

// The window that receives a pointer's events, and the location in its panel
// pixels.
struct PointerHeard {
  gfx::AcceleratedWidget window = gfx::kNullAcceleratedWidget;
  gfx::PointF location;
};

// Returns which window receives a pointer at `location` on the engine's
// desktop, and where.
//
// The desk's host if it exists, otherwise the window under the pointer.
// Nothing when no screen holds the pointer.
std::optional<PointerHeard> PointerHeardAt(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    gfx::AcceleratedWidget desk_host,
    const gfx::PointF& location);

// Returns where a pointer at `location` on the engine's desktop stays when the
// window it is on moves or goes away: on whichever of `screens` holds that
// spot now, in its panel pixels. Nothing when none holds it yet.
//
// Upstream keeps the pointer at its spot in the window, which carries it to
// the monitor the window moved to, or puts it in the middle of the primary
// window. On a desk the host's window moves when its monitor sleeps or wakes,
// and the pointer on another monitor must not move with it.
std::optional<PointerCrossing> PointerStaysAt(
    const std::vector<PointerScreen>& screens,
    const gfx::PointF& location);

// Returns whether a window at `bounds_in_screen` receives keys, with the
// pointer at `pointer` on the engine's desktop.
//
// Keys go to the screen under the pointer. Upstream offers each key to every
// `DrmWindowHost` and the first one added accepts all of them, since non-ash
// builds lack keyboard focus logic. The pointer is the one signal both the
// engine and the shell agree on.
bool HasTheKeyboard(const gfx::Rect& bounds_in_screen,
                    const gfx::PointF& pointer);

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CROSSING_H_
