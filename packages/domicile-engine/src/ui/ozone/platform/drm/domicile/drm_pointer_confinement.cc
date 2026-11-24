// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_pointer_confinement.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "base/check.h"

namespace ui {
namespace {

// The engine's desktop place of `at`, a place in its window's panel pixels.
gfx::PointF OnTheDesktop(const std::vector<PointerScreen>& screens,
                         const PointerCrossing& at) {
  const auto on = std::ranges::find(screens, at.window, &PointerScreen::window);
  CHECK(on != screens.end());
  return at.location + on->bounds_in_screen.OffsetFromOrigin();
}

// Whether `box` holds `point`, right and bottom edges left out as a pixel
// grid's are.
bool Holds(const gfx::RectF& box, const gfx::PointF& point) {
  return point.x() >= box.x() && point.x() < box.right() &&
         point.y() >= box.y() && point.y() < box.bottom();
}

// The point of `box` nearest `point`: on its last pixel at the right and
// bottom, which are one past the edge.
gfx::PointF Nearest(const gfx::RectF& box, const gfx::PointF& point) {
  return gfx::PointF(
      std::clamp(point.x(), box.x(), std::max(box.x(), box.right() - 1)),
      std::clamp(point.y(), box.y(), std::max(box.y(), box.bottom() - 1)));
}

}  // namespace

std::optional<PointerCrossing> ConfinedMove(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    const PointerConfinement& confinement,
    const PointerCrossing& from,
    const PointerCrossing& to) {
  if (confinement.boxes.empty()) {
    return std::nullopt;
  }
  const gfx::PointF here = PointerInWindow(
      screens, layout, OnTheDesktop(screens, from), confinement.window);
  const gfx::PointF there = PointerInWindow(
      screens, layout, OnTheDesktop(screens, to), confinement.window);
  if (std::ranges::any_of(confinement.boxes, [&](const gfx::RectF& box) {
        return Holds(box, there);
      })) {
    return std::nullopt;
  }
  // The box the pointer is in, or else the one nearest it.
  const gfx::RectF* held = nullptr;
  float nearest = std::numeric_limits<float>::infinity();
  for (const gfx::RectF& box : confinement.boxes) {
    const float distance = (Nearest(box, here) - here).Length();
    if (Holds(box, here) || distance < nearest) {
      held = &box;
      nearest = Holds(box, here) ? -1 : distance;
    }
  }
  CHECK(held);
  const gfx::PointF stopped = Nearest(*held, there);
  const std::optional<PointerCrossing> crossing =
      PointerCrossingFor(screens, layout, confinement.window, stopped);
  return crossing.value_or(PointerCrossing{confinement.window, stopped});
}

}  // namespace ui
