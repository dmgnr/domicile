// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_AURA_DOMICILE_DESK_TARGETER_H_
#define UI_AURA_DOMICILE_DESK_TARGETER_H_

#include <optional>

#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace aura {

class Window;

// Returns `at` in page coordinates when it is outside the root window's
// `root` size but inside `page_in_root`. Otherwise returns `std::nullopt`,
// leaving the event to aura's normal targeting.
std::optional<gfx::PointF> DeskPagePoint(const gfx::Size& root,
                                         const gfx::Rect& page_in_root,
                                         const gfx::PointF& at);

// Sends `page` every pointer event that reaches `root` outside its bounds. A
// null `page` stops this.
//
// On a tty the desk is one page spanning every monitor, shown in the host
// monitor's window (see content/public/browser/domicile_desk.h). Ozone sends
// that window pointer events from every monitor, so a pointer on another
// monitor lands outside the window's bounds. aura only targets within a
// window's bounds, so without this those events reach the root and are lost.
//
// aura's own targeting still runs first: a pressed button's window and a
// capture keep every move, so a drag can leave the host monitor and return.
void TargetDeskPage(Window* root, Window* page);

// Returns the window that handles a point `at` in `root`'s coordinates, as an
// event there would be targeted: on another monitor, inside the page
// `TargetDeskPage` gave `root`. A drop finds its target with this, since a
// drag carries no event to target.
Window* DeskWindowAt(Window* root, const gfx::PointF& at);

}  // namespace aura

#endif  // UI_AURA_DOMICILE_DESK_TARGETER_H_
