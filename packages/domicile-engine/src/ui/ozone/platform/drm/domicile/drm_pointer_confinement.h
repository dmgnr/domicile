// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CONFINEMENT_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CONFINEMENT_H_

#include <optional>
#include <vector>

#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/ozone/platform/drm/domicile/drm_pointer_crossing.h"
#include "ui/ozone/public/ozone_platform.h"

namespace ui {

// Where a game asked the pointer to stay (zwp_pointer_constraints_v1's
// confinement): `boxes` in `window`'s panel pixels. The window is the desk's
// host, the one page every monitor shows, so a box may reach past its edge
// onto any monitor beside it. See
// `OzonePlatform::SetDomicilePointerConfinement`.
struct PointerConfinement {
  gfx::AcceleratedWidget window = gfx::kNullAcceleratedWidget;
  std::vector<gfx::RectF> boxes;
};

// Where a confined pointer goes instead of `to`, or nothing when `to` is
// inside a box and the move goes as it would have.
//
// - `from` is where the pointer is and `to` where the move would put it, each
//   a window and a place in its panel pixels, after any crossing onto another
//   monitor. Both are mapped onto the confinement's window, so a box spanning
//   a seam holds the pointer on either side of it.
// - Outside every box, the pointer stops at the nearest edge of the box it
//   was in, so it slides along that edge as sway's does. A pointer that was
//   in none, as when the confinement began, goes to the nearest box.
// - Mapped back onto whichever monitor holds that place. Nothing for no boxes.
std::optional<PointerCrossing> ConfinedMove(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    const PointerConfinement& confinement,
    const PointerCrossing& from,
    const PointerCrossing& to);

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_POINTER_CONFINEMENT_H_
