// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_CURSOR_DISPLAY_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_CURSOR_DISPLAY_H_

namespace aura {
class Window;
}  // namespace aura

namespace domicile {

// Draws the pointer for the display `root` is on, when it is drawn for
// another. See components/domicile/browser/cursor_display.h.
//
// `root` is the desk's host window, which hears every pointer event. Called
// once the displays settle after a change: mid-change the cursor can be
// handed a display that is gone, and nothing else hands it the right one
// until the pointer enters a new window.
void FitCursorToDisplayOf(aura::Window* root);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_CURSOR_DISPLAY_H_
