// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_CURSOR_DISPLAY_H_
#define COMPONENTS_DOMICILE_BROWSER_CURSOR_DISPLAY_H_

#include <cstdint>

#include "ui/display/display.h"

namespace domicile {

// Whether the pointer is drawn for a display other than `now`, the display
// its window is on: another display, or `now` at an old scale or turn. The
// pointer's size and turn come from the display it is drawn for.
bool CursorDisplayStale(const display::Display& drawn_for,
                        const display::Display& now);

// Whether a display change of `changed_metrics`, a
// `display::DisplayObserver::DisplayMetric` mask, changes how the pointer is
// drawn on that display: its scale or its turn.
bool DisplayChangeRefitsPointer(uint32_t changed_metrics);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_CURSOR_DISPLAY_H_
