// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/pointer_warp.h"

#include <algorithm>
#include <cmath>
#include <optional>
#include <vector>

#include "base/numerics/safe_conversions.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace domicile {
namespace {

// The nearest pixel to `at` within [`from`, `to`].
//
// `base::ClampRound` saturates values outside the int range, where a cast
// would be undefined.
int Pinned(double at, int from, int to) {
  return std::clamp(base::ClampRound(at), from, to);
}

}  // namespace

std::optional<gfx::Point> PointerWarpTarget(const gfx::Rect& page,
                                            double x,
                                            double y) {
  if (page.IsEmpty() || !std::isfinite(x) || !std::isfinite(y)) {
    return std::nullopt;
  }
  // `right()` and `bottom()` are one past the edge, which may be on another
  // monitor.
  return gfx::Point(Pinned(page.x() + x, page.x(), page.right() - 1),
                    Pinned(page.y() + y, page.y(), page.bottom() - 1));
}

bool PointerAlreadyOver(const std::optional<gfx::PointF>& pointer,
                        const gfx::RectF& box) {
  // `gfx::RectF::Contains` leaves out the right and bottom edges.
  return pointer.has_value() && pointer->x() >= box.x() &&
         pointer->x() <= box.right() && pointer->y() >= box.y() &&
         pointer->y() <= box.bottom();
}

std::optional<std::vector<gfx::RectF>> PointerConfinementBoxes(
    const gfx::Rect& page,
    const std::vector<gfx::RectF>& boxes) {
  std::vector<gfx::RectF> held;
  for (const gfx::RectF& box : boxes) {
    if (!std::isfinite(box.x()) || !std::isfinite(box.y()) ||
        !std::isfinite(box.width()) || !std::isfinite(box.height())) {
      return std::nullopt;
    }
    gfx::RectF in_root = box + gfx::Vector2dF(page.x(), page.y());
    in_root.Intersect(gfx::RectF(page));
    if (!in_root.IsEmpty()) {
      held.push_back(in_root);
    }
  }
  if (!boxes.empty() && held.empty()) {
    return std::nullopt;
  }
  return held;
}

}  // namespace domicile
