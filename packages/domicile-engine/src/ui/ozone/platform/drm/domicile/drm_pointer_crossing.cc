// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_pointer_crossing.h"

#include <algorithm>

#include "base/check.h"
#include "ui/gfx/geometry/point_conversions.h"
#include "ui/gfx/geometry/size.h"

namespace ui {
namespace {

bool IsSideways(display::Display::Rotation rotation) {
  return rotation == display::Display::ROTATE_90 ||
         rotation == display::Display::ROTATE_270;
}

// The panel's size as the user sees it, after rotation.
gfx::Size UprightSize(const PointerScreen& screen) {
  const gfx::Size panel = screen.bounds_in_screen.size();
  return IsSideways(screen.rotation) ? gfx::Size(panel.height(), panel.width())
                                     : panel;
}

// Converts a panel point to the upright frame. Inverse of `ToPanel`. Rotates
// the same way as `CursorController::ApplyCursorConfigForWindow`, so a pointer
// leaves by the edge it was moving toward.
gfx::PointF ToUpright(const PointerScreen& screen, const gfx::PointF& panel) {
  const float width = static_cast<float>(screen.bounds_in_screen.width());
  const float height = static_cast<float>(screen.bounds_in_screen.height());
  switch (screen.rotation) {
    case display::Display::ROTATE_0:
      return panel;
    case display::Display::ROTATE_90:
      return gfx::PointF(panel.y(), width - panel.x());
    case display::Display::ROTATE_180:
      return gfx::PointF(width - panel.x(), height - panel.y());
    case display::Display::ROTATE_270:
      return gfx::PointF(height - panel.y(), panel.x());
  }
}

gfx::PointF ToPanel(const PointerScreen& screen, const gfx::PointF& upright) {
  const float width = static_cast<float>(screen.bounds_in_screen.width());
  const float height = static_cast<float>(screen.bounds_in_screen.height());
  switch (screen.rotation) {
    case display::Display::ROTATE_0:
      return upright;
    case display::Display::ROTATE_90:
      return gfx::PointF(width - upright.y(), upright.x());
    case display::Display::ROTATE_180:
      return gfx::PointF(width - upright.x(), height - upright.y());
    case display::Display::ROTATE_270:
      return gfx::PointF(upright.y(), height - upright.x());
  }
}

// A screen's rectangle on the shell's desktop, in logical pixels.
struct Desk {
  float x;
  float y;
  float width;
  float height;

  // Whether `point` is on this screen, or within `seam` of it.
  bool Holds(const gfx::PointF& point, float seam) const {
    return point.x() >= x - seam && point.x() < x + width + seam &&
           point.y() >= y - seam && point.y() < y + height + seam;
  }

  gfx::PointF Clamped(const gfx::PointF& point) const {
    return gfx::PointF(std::clamp(point.x(), x, x + width),
                       std::clamp(point.y(), y, y + height));
  }

  // Converts between an upright point on a `size`-pixel screen and the desk.
  gfx::PointF ToDesk(const gfx::PointF& upright, const gfx::Size& size) const {
    return gfx::PointF(
        x + upright.x() * width / static_cast<float>(size.width()),
        y + upright.y() * height / static_cast<float>(size.height()));
  }
  gfx::PointF FromDesk(const gfx::PointF& point, const gfx::Size& size) const {
    return gfx::PointF(
        (point.x() - x) * static_cast<float>(size.width()) / width,
        (point.y() - y) * static_cast<float>(size.height()) / height);
  }
};

// The largest gap between screens that still counts as touching. Profile
// positions round outward, by up to one logical pixel.
constexpr float kSeam = 1.f;

// Returns `screen`'s place on the desk, or nothing if the layout leaves it
// dark. With an empty layout, the engine's desktop is the desk.
std::optional<Desk> DeskOf(const PointerScreen& screen,
                           const std::vector<DomicileDisplayLayout>& layout) {
  if (layout.empty()) {
    const gfx::Size size = UprightSize(screen);
    return Desk{static_cast<float>(screen.bounds_in_screen.x()),
                static_cast<float>(screen.bounds_in_screen.y()),
                static_cast<float>(size.width()),
                static_cast<float>(size.height())};
  }
  const auto wanted =
      std::ranges::find_if(layout, [&](const DomicileDisplayLayout& display) {
        return display.enabled &&
               display.origin == screen.bounds_in_screen.origin();
      });
  if (wanted == layout.end() || wanted->desk.IsEmpty()) {
    return std::nullopt;
  }
  return Desk{static_cast<float>(wanted->desk.x()),
              static_cast<float>(wanted->desk.y()),
              static_cast<float>(wanted->desk.width()),
              static_cast<float>(wanted->desk.height())};
}

}  // namespace

std::optional<PointerCrossing> PointerCrossingFor(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    gfx::AcceleratedWidget from,
    const gfx::PointF& location) {
  const auto on = std::ranges::find(screens, from, &PointerScreen::window);
  CHECK(on != screens.end());
  const std::optional<Desk> here = DeskOf(*on, layout);
  const gfx::PointF upright = ToUpright(*on, location);
  const gfx::Size size = UprightSize(*on);
  const bool inside = upright.x() >= 0 && upright.y() >= 0 &&
                      upright.x() < static_cast<float>(size.width()) &&
                      upright.y() < static_cast<float>(size.height());
  if (inside || !here.has_value()) {
    return std::nullopt;
  }

  const gfx::PointF on_the_desk = here->ToDesk(upright, size);
  std::optional<PointerCrossing> crossing;
  for (const float seam : {0.f, kSeam}) {
    for (const PointerScreen& screen : screens) {
      const std::optional<Desk> there = DeskOf(screen, layout);
      if (!crossing.has_value() && screen.window != from && there.has_value() &&
          there->Holds(on_the_desk, seam)) {
        crossing = PointerCrossing{
            screen.window,
            ToPanel(screen, there->FromDesk(there->Clamped(on_the_desk),
                                            UprightSize(screen)))};
      }
    }
  }
  return crossing;
}

gfx::PointF PointerInWindow(const std::vector<PointerScreen>& screens,
                            const std::vector<DomicileDisplayLayout>& layout,
                            const gfx::PointF& location,
                            gfx::AcceleratedWidget window) {
  const auto to = std::ranges::find(screens, window, &PointerScreen::window);
  CHECK(to != screens.end());
  const gfx::PointF by_the_row =
      location - to->bounds_in_screen.OffsetFromOrigin();
  const auto on =
      std::ranges::find_if(screens, [&](const PointerScreen& screen) {
        return screen.bounds_in_screen.Contains(
            gfx::ToFlooredPoint(location));
      });
  if (on == screens.end() || on == to) {
    return by_the_row;
  }
  const std::optional<Desk> here = DeskOf(*on, layout);
  const std::optional<Desk> there = DeskOf(*to, layout);
  if (!here.has_value() || !there.has_value()) {
    return by_the_row;
  }
  const gfx::PointF on_the_desk = here->ToDesk(
      ToUpright(*on, location - on->bounds_in_screen.OffsetFromOrigin()),
      UprightSize(*on));
  return ToPanel(*to, there->FromDesk(on_the_desk, UprightSize(*to)));
}

std::optional<PointerHeard> PointerHeardAt(
    const std::vector<PointerScreen>& screens,
    const std::vector<DomicileDisplayLayout>& layout,
    gfx::AcceleratedWidget desk_host,
    const gfx::PointF& location) {
  if (std::ranges::find(screens, desk_host, &PointerScreen::window) !=
      screens.end()) {
    return PointerHeard{desk_host,
                        PointerInWindow(screens, layout, location, desk_host)};
  }
  const auto on =
      std::ranges::find_if(screens, [&](const PointerScreen& screen) {
        return screen.bounds_in_screen.Contains(
            gfx::ToFlooredPoint(location));
      });
  if (on == screens.end()) {
    return std::nullopt;
  }
  return PointerHeard{on->window,
                      location - on->bounds_in_screen.OffsetFromOrigin()};
}

std::optional<PointerCrossing> PointerStaysAt(
    const std::vector<PointerScreen>& screens,
    const gfx::PointF& location) {
  const auto on =
      std::ranges::find_if(screens, [&](const PointerScreen& screen) {
        return screen.bounds_in_screen.Contains(gfx::ToFlooredPoint(location));
      });
  if (on == screens.end()) {
    return std::nullopt;
  }
  return PointerCrossing{on->window,
                         location - on->bounds_in_screen.OffsetFromOrigin()};
}

bool HasTheKeyboard(const gfx::Rect& bounds_in_screen,
                    const gfx::PointF& pointer) {
  return bounds_in_screen.Contains(gfx::ToFlooredPoint(pointer));
}

}  // namespace ui
