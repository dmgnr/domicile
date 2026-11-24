// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/cursor_display.h"

#include "ui/display/display_observer.h"

namespace domicile {

bool CursorDisplayStale(const display::Display& drawn_for,
                        const display::Display& now) {
  return drawn_for.id() != now.id() ||
         drawn_for.device_scale_factor() != now.device_scale_factor() ||
         drawn_for.panel_rotation() != now.panel_rotation();
}

bool DisplayChangeRefitsPointer(uint32_t changed_metrics) {
  return (changed_metrics &
          (display::DisplayObserver::DISPLAY_METRIC_DEVICE_SCALE_FACTOR |
           display::DisplayObserver::DISPLAY_METRIC_ROTATION)) != 0;
}

}  // namespace domicile
