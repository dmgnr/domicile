// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_INPUT_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_INPUT_H_

#include <string>
#include <variant>

#include "base/time/time.h"
#include "base/values.h"
#include "components/domicile/browser/electron_page_reports.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "ui/base/cursor/cursor.h"

namespace domicile {

// A page's input events as an Electron app's webContents sees them, and the
// events webContents.sendInputEvent makes. The keys are the wire's, as
// electron_page_reports.h lists them.

// before-input-event's `input` for `event`, a RawKeyDown ("keyDown") or a
// KeyUp ("keyUp").
base::DictValue ElectronKeyInput(const input::NativeWebKeyboardEvent& event);

// input-event's `event`: its type by Electron's name ("rawKeyDown",
// "mouseMove", "gestureScrollBegin") and modifiers, with a key's "key_code"
// and a mouse event's position, button and clicks. before-mouse-event's
// `mouse` for a mouse event.
base::DictValue ElectronInputEventValue(const blink::WebInputEvent& event);

// The event sendInputEvent makes of `input`, made at `now`. A key it cannot
// name is VKEY_UNKNOWN, as Electron's.
using ElectronMadeInput = std::variant<input::NativeWebKeyboardEvent,
                                       blink::WebMouseEvent,
                                       blink::WebMouseWheelEvent>;
ElectronMadeInput ElectronMakeInput(
    const ElectronSyntheticInput& input,
    base::TimeTicks now);

// cursor-changed's type for `cursor`, by Electron's name, with a custom
// one's picture.
ElectronCursor ElectronCursorOf(const ui::Cursor& cursor);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_INPUT_H_
