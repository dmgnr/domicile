// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_POINTER_WARP_H_
#define COMPONENTS_DOMICILE_BROWSER_POINTER_WARP_H_

#include <optional>
#include <vector>

#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"

namespace domicile {

// The cursor position for a page's `warp_pointer` request.
//
// With focus-follows-mouse, the cursor must follow keyboard focus changes, as
// with sway's `mouse_warping`. A page cannot move the cursor, so the engine
// does it.
//
// `page` is the page's bounds in its window's root, in DIP. `x` and `y` are
// page coordinates, as in `PointerEvent.clientX`/`clientY`.
//
// Returns nothing for a non-finite coordinate or an empty `page`. Otherwise
// clamps into `page`, so a renderer cannot move the cursor onto another window.
std::optional<gfx::Point> PointerWarpTarget(const gfx::Rect& page,
                                            double x,
                                            double y);

// Whether a warp that the page asked to skip over `box` is skipped.
//
// The shell warps only when the pointer will not be over the window it
// focuses. It cannot see the pointer move over a browser window's page, so the
// browser, which can, makes the last check. `pointer` and `box` are in the
// page's CSS pixels, edges included; `pointer` is `std::nullopt` off the page.
bool PointerAlreadyOver(const std::optional<gfx::PointF>& pointer,
                        const gfx::RectF& box);

// The boxes a page's `confine_pointer` request holds the pointer in, in its
// window's root, in DIP.
//
// A game or VM viewer confines the pointer to its window, or a region of it,
// through zwp_pointer_constraints_v1; the shell passes that on as boxes in its
// page's CSS pixels, which this maps as `PointerWarpTarget` maps a point.
//
// Returns nothing for a non-finite box, which Blink rejects first,
// or when no box overlaps `page`. Otherwise clips each box to `page`, so a
// renderer cannot hold the pointer on another window, and leaves out boxes
// that clip to nothing. No `boxes` gives none back, which lets go.
std::optional<std::vector<gfx::RectF>> PointerConfinementBoxes(
    const gfx::Rect& page,
    const std::vector<gfx::RectF>& boxes);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_POINTER_WARP_H_
