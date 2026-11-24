// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_input.h"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/cursor/mojom/cursor_type.mojom-shared.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/events/keycodes/keyboard_code_conversion.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/events/types/scroll_types.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/point_f.h"

namespace domicile {
namespace {

using blink::WebInputEvent;

// Electron's names for the modifiers, in its order.
constexpr std::pair<int, std::string_view> kModifierNames[] = {
    {WebInputEvent::kShiftKey, "shift"},
    {WebInputEvent::kControlKey, "control"},
    {WebInputEvent::kAltKey, "alt"},
    {WebInputEvent::kMetaKey, "meta"},
    {WebInputEvent::kIsKeyPad, "iskeypad"},
    {WebInputEvent::kIsAutoRepeat, "isautorepeat"},
    {WebInputEvent::kLeftButtonDown, "leftbuttondown"},
    {WebInputEvent::kMiddleButtonDown, "middlebuttondown"},
    {WebInputEvent::kRightButtonDown, "rightbuttondown"},
    {WebInputEvent::kCapsLockOn, "capslock"},
    {WebInputEvent::kNumLockOn, "numlock"},
    {WebInputEvent::kIsLeft, "left"},
    {WebInputEvent::kIsRight, "right"},
};

// sendInputEvent's other names for some of them.
constexpr std::pair<std::string_view, int> kModifierAliases[] = {
    {"ctrl", WebInputEvent::kControlKey},
    {"command", WebInputEvent::kMetaKey},
    {"cmd", WebInputEvent::kMetaKey},
};

// A named key, as an accelerator names it, lowercased.
struct NamedKey {
  std::string_view name;
  ui::KeyboardCode code;
  ui::DomKey key;
};

constexpr NamedKey kNamedKeys[] = {
    {"enter", ui::VKEY_RETURN, ui::DomKey::ENTER},
    {"return", ui::VKEY_RETURN, ui::DomKey::ENTER},
    {"tab", ui::VKEY_TAB, ui::DomKey::TAB},
    {"backspace", ui::VKEY_BACK, ui::DomKey::BACKSPACE},
    {"delete", ui::VKEY_DELETE, ui::DomKey::DEL},
    {"insert", ui::VKEY_INSERT, ui::DomKey::INSERT},
    {"escape", ui::VKEY_ESCAPE, ui::DomKey::ESCAPE},
    {"esc", ui::VKEY_ESCAPE, ui::DomKey::ESCAPE},
    {"up", ui::VKEY_UP, ui::DomKey::ARROW_UP},
    {"down", ui::VKEY_DOWN, ui::DomKey::ARROW_DOWN},
    {"left", ui::VKEY_LEFT, ui::DomKey::ARROW_LEFT},
    {"right", ui::VKEY_RIGHT, ui::DomKey::ARROW_RIGHT},
    {"home", ui::VKEY_HOME, ui::DomKey::HOME},
    {"end", ui::VKEY_END, ui::DomKey::END},
    {"pageup", ui::VKEY_PRIOR, ui::DomKey::PAGE_UP},
    {"pagedown", ui::VKEY_NEXT, ui::DomKey::PAGE_DOWN},
    {"shift", ui::VKEY_SHIFT, ui::DomKey::SHIFT},
    {"control", ui::VKEY_CONTROL, ui::DomKey::CONTROL},
    {"ctrl", ui::VKEY_CONTROL, ui::DomKey::CONTROL},
    {"alt", ui::VKEY_MENU, ui::DomKey::ALT},
    {"meta", ui::VKEY_LWIN, ui::DomKey::META},
    {"super", ui::VKEY_LWIN, ui::DomKey::META},
    {"capslock", ui::VKEY_CAPITAL, ui::DomKey::CAPS_LOCK},
    {"numlock", ui::VKEY_NUMLOCK, ui::DomKey::NUM_LOCK},
    {"scrolllock", ui::VKEY_SCROLL, ui::DomKey::SCROLL_LOCK},
    {"printscreen", ui::VKEY_SNAPSHOT, ui::DomKey::PRINT_SCREEN},
    {"f1", ui::VKEY_F1, ui::DomKey::F1},
    {"f2", ui::VKEY_F2, ui::DomKey::F2},
    {"f3", ui::VKEY_F3, ui::DomKey::F3},
    {"f4", ui::VKEY_F4, ui::DomKey::F4},
    {"f5", ui::VKEY_F5, ui::DomKey::F5},
    {"f6", ui::VKEY_F6, ui::DomKey::F6},
    {"f7", ui::VKEY_F7, ui::DomKey::F7},
    {"f8", ui::VKEY_F8, ui::DomKey::F8},
    {"f9", ui::VKEY_F9, ui::DomKey::F9},
    {"f10", ui::VKEY_F10, ui::DomKey::F10},
    {"f11", ui::VKEY_F11, ui::DomKey::F11},
    {"f12", ui::VKEY_F12, ui::DomKey::F12},
};

// Printable keys an accelerator names by word, with what they type.
constexpr std::pair<std::string_view, char> kNamedCharacters[] = {
    {"space", ' '},
    {"plus", '+'},
};

// The US layout key of `character`, and whether it takes Shift there, as
// Electron's sendInputEvent reads a character.
struct CharacterKey {
  ui::KeyboardCode code;
  bool shifted;
};

constexpr std::pair<char, CharacterKey> kPunctuation[] = {
    {' ', {ui::VKEY_SPACE, false}},    {')', {ui::VKEY_0, true}},
    {'!', {ui::VKEY_1, true}},         {'@', {ui::VKEY_2, true}},
    {'#', {ui::VKEY_3, true}},         {'$', {ui::VKEY_4, true}},
    {'%', {ui::VKEY_5, true}},         {'^', {ui::VKEY_6, true}},
    {'&', {ui::VKEY_7, true}},         {'*', {ui::VKEY_8, true}},
    {'(', {ui::VKEY_9, true}},         {';', {ui::VKEY_OEM_1, false}},
    {':', {ui::VKEY_OEM_1, true}},     {'=', {ui::VKEY_OEM_PLUS, false}},
    {'+', {ui::VKEY_OEM_PLUS, true}},  {',', {ui::VKEY_OEM_COMMA, false}},
    {'<', {ui::VKEY_OEM_COMMA, true}}, {'-', {ui::VKEY_OEM_MINUS, false}},
    {'_', {ui::VKEY_OEM_MINUS, true}}, {'.', {ui::VKEY_OEM_PERIOD, false}},
    {'>', {ui::VKEY_OEM_PERIOD, true}}, {'/', {ui::VKEY_OEM_2, false}},
    {'?', {ui::VKEY_OEM_2, true}},     {'`', {ui::VKEY_OEM_3, false}},
    {'~', {ui::VKEY_OEM_3, true}},     {'[', {ui::VKEY_OEM_4, false}},
    {'{', {ui::VKEY_OEM_4, true}},     {'\\', {ui::VKEY_OEM_5, false}},
    {'|', {ui::VKEY_OEM_5, true}},     {']', {ui::VKEY_OEM_6, false}},
    {'}', {ui::VKEY_OEM_6, true}},     {'\'', {ui::VKEY_OEM_7, false}},
    {'"', {ui::VKEY_OEM_7, true}},
};

// What a key sendInputEvent names is: its codes, and what it types, if
// anything.
struct Key {
  ui::KeyboardCode code = ui::VKEY_UNKNOWN;
  ui::DomKey key;
  bool shifted = false;
  std::optional<char16_t> typed;
};

Key KeyOfCharacter(char16_t character) {
  if (character >= 'a' && character <= 'z') {
    return Key{.code = static_cast<ui::KeyboardCode>(ui::VKEY_A + character - 'a'),
               .key = ui::DomKey::FromCharacter(character),
               .typed = character};
  } else if (character >= 'A' && character <= 'Z') {
    return Key{.code = static_cast<ui::KeyboardCode>(ui::VKEY_A + character - 'A'),
               .key = ui::DomKey::FromCharacter(character),
               .shifted = true,
               .typed = character};
  } else if (character >= '0' && character <= '9') {
    return Key{.code = static_cast<ui::KeyboardCode>(ui::VKEY_0 + character - '0'),
               .key = ui::DomKey::FromCharacter(character),
               .typed = character};
  }
  const auto* punctuation =
      std::ranges::find(kPunctuation, character,
                        &std::pair<char, CharacterKey>::first);
  if (punctuation != std::end(kPunctuation)) {
    return Key{.code = punctuation->second.code,
               .key = ui::DomKey::FromCharacter(character),
               .shifted = punctuation->second.shifted,
               .typed = character};
  }
  // A character no US key types still types, as Electron's does.
  return Key{.key = ui::DomKey::FromCharacter(character), .typed = character};
}

Key KeyNamed(const std::string& name) {
  const std::u16string characters = base::UTF8ToUTF16(name);
  if (characters.size() == 1) {
    return KeyOfCharacter(characters[0]);
  }
  const std::string lower = base::ToLowerASCII(name);
  const auto* named = std::ranges::find(kNamedKeys, lower, &NamedKey::name);
  if (named != std::end(kNamedKeys)) {
    return Key{.code = named->code, .key = named->key};
  }
  const auto* character = std::ranges::find(
      kNamedCharacters, lower, &std::pair<std::string_view, char>::first);
  if (character != std::end(kNamedCharacters)) {
    return KeyOfCharacter(character->second);
  }
  // A name Domicile doesn't know is a key no code names, as Electron sends
  // one.
  return Key{.key = ui::DomKey::UNIDENTIFIED};
}

int ModifiersOf(const std::vector<std::string>& names) {
  int modifiers = 0;
  for (const std::string& name : names) {
    const auto* found =
        std::ranges::find(kModifierNames, name,
                          &std::pair<int, std::string_view>::second);
    const auto* alias =
        std::ranges::find(kModifierAliases, name,
                          &std::pair<std::string_view, int>::first);
    // The protocol took only Electron's names.
    CHECK(found != std::end(kModifierNames) ||
          alias != std::end(kModifierAliases))
        << name;
    modifiers |= found != std::end(kModifierNames) ? found->first
                                                   : alias->second;
  }
  return modifiers;
}

base::ListValue ModifierList(int modifiers) {
  base::ListValue list;
  for (const auto& [bit, name] : kModifierNames) {
    if ((modifiers & bit) != 0) {
      list.Append(name);
    }
  }
  return list;
}

// `type`'s name, as Electron gives it: Chromium's with its first letter
// lowercased.
std::string TypeName(WebInputEvent::Type type) {
  std::string name = WebInputEvent::GetName(type);
  name[0] = base::ToLowerASCII(name[0]);
  return name;
}

blink::WebMouseEvent::Button ButtonNamed(std::string_view name) {
  if (name == "middle") {
    return blink::WebMouseEvent::Button::kMiddle;
  } else if (name == "right") {
    return blink::WebMouseEvent::Button::kRight;
  } else {
    CHECK_EQ(name, "left");
    return blink::WebMouseEvent::Button::kLeft;
  }
}

std::optional<std::string_view> ButtonName(blink::WebMouseEvent::Button button) {
  if (button == blink::WebMouseEvent::Button::kLeft) {
    return "left";
  } else if (button == blink::WebMouseEvent::Button::kMiddle) {
    return "middle";
  } else if (button == blink::WebMouseEvent::Button::kRight) {
    return "right";
  } else {
    // No button, or one Electron has no name for.
    return std::nullopt;
  }
}

void AddMouse(base::DictValue& value, const blink::WebMouseEvent& mouse) {
  value.Set("x", mouse.PositionInWidget().x());
  value.Set("y", mouse.PositionInWidget().y());
  value.Set("global_x", mouse.PositionInScreen().x());
  value.Set("global_y", mouse.PositionInScreen().y());
  value.Set("movement_x", mouse.movement_x);
  value.Set("movement_y", mouse.movement_y);
  value.Set("click_count", mouse.click_count);
  if (const std::optional<std::string_view> button = ButtonName(mouse.button)) {
    value.Set("button", *button);
  }
}

WebInputEvent::Type KeyType(std::string_view type) {
  if (type == "keyDown") {
    return WebInputEvent::Type::kRawKeyDown;
  } else if (type == "keyUp") {
    return WebInputEvent::Type::kKeyUp;
  } else {
    CHECK_EQ(type, "char");
    return WebInputEvent::Type::kChar;
  }
}

WebInputEvent::Type MouseType(std::string_view type) {
  if (type == "mouseDown") {
    return WebInputEvent::Type::kMouseDown;
  } else if (type == "mouseUp") {
    return WebInputEvent::Type::kMouseUp;
  } else if (type == "mouseMove") {
    return WebInputEvent::Type::kMouseMove;
  } else if (type == "mouseEnter") {
    return WebInputEvent::Type::kMouseEnter;
  } else if (type == "mouseLeave") {
    return WebInputEvent::Type::kMouseLeave;
  } else {
    CHECK_EQ(type, "contextMenu");
    return WebInputEvent::Type::kContextMenu;
  }
}

// The control character a char of `code` types, as Chromium's keyboard
// does, or none.
char16_t ControlCharacter(ui::KeyboardCode code) {
  switch (code) {
    case ui::VKEY_RETURN:
      return u'\r';
    case ui::VKEY_TAB:
      return u'\t';
    case ui::VKEY_BACK:
      return u'\b';
    case ui::VKEY_ESCAPE:
      return u'\x1b';
    default:
      return u'\0';
  }
}

ElectronMadeInput MakeKey(const ElectronSyntheticInput& input,
                          base::TimeTicks now) {
  const Key key = KeyNamed(input.key_code);
  const int modifiers = ModifiersOf(input.modifiers) |
                        (key.shifted ? WebInputEvent::kShiftKey : 0);
  input::NativeWebKeyboardEvent event(KeyType(input.type), modifiers, now);
  event.windows_key_code = key.code;
  event.dom_code =
      static_cast<int>(ui::UsLayoutKeyboardCodeToDomCode(key.code));
  event.dom_key = key.key;
  // Only a char types; Enter, Tab, Backspace and Escape type their control
  // characters.
  if (event.GetType() == WebInputEvent::Type::kChar) {
    const char16_t typed =
        key.typed.has_value() ? *key.typed : ControlCharacter(key.code);
    event.text[0] = typed;
    event.unmodified_text[0] = typed;
  }
  return event;
}

ElectronMadeInput MakeMouse(const ElectronSyntheticInput& input,
                            base::TimeTicks now) {
  const gfx::PointF position(input.x, input.y);
  const gfx::PointF on_screen(input.global_x.value_or(input.x),
                              input.global_y.value_or(input.y));
  const int modifiers = ModifiersOf(input.modifiers);
  if (input.type == "mouseWheel") {
    blink::WebMouseWheelEvent wheel(WebInputEvent::Type::kMouseWheel, modifiers,
                                    now);
    wheel.SetPositionInWidget(position);
    wheel.SetPositionInScreen(on_screen);
    wheel.delta_x = static_cast<float>(input.delta_x);
    wheel.delta_y = static_cast<float>(input.delta_y);
    wheel.wheel_ticks_x = static_cast<float>(input.wheel_ticks_x);
    wheel.wheel_ticks_y = static_cast<float>(input.wheel_ticks_y);
    // As Electron reads them: precise deltas are pixels, and an event that
    // may not scroll scrolls by page, which a page cannot be scrolled with
    // from a wheel.
    wheel.delta_units = !input.can_scroll
                            ? ui::ScrollGranularity::kScrollByPage
                        : input.has_precise_scrolling_deltas
                            ? ui::ScrollGranularity::kScrollByPrecisePixel
                            : ui::ScrollGranularity::kScrollByPixel;
    return wheel;
  }
  const bool pressing = input.type == "mouseDown" || input.type == "mouseUp";
  const blink::WebMouseEvent::Button button =
      input.button.has_value() ? ButtonNamed(*input.button)
      : pressing               ? blink::WebMouseEvent::Button::kLeft
                               : blink::WebMouseEvent::Button::kNoButton;
  blink::WebMouseEvent mouse(MouseType(input.type), position, on_screen,
                             button, input.click_count, modifiers, now);
  mouse.movement_x = static_cast<int>(input.movement_x);
  mouse.movement_y = static_cast<int>(input.movement_y);
  // A move with no button holds none down.
  if (button != blink::WebMouseEvent::Button::kNoButton) {
    mouse.UpdateEventModifiersToMatchButton();
  }
  return mouse;
}


// Electron's name for `type`, as its cursor-changed gives it.
std::string_view CursorName(ui::mojom::CursorType type) {
  switch (type) {
    case ui::mojom::CursorType::kNull:
      return "null";
    case ui::mojom::CursorType::kPointer:
      return "default";
    case ui::mojom::CursorType::kCross:
      return "crosshair";
    case ui::mojom::CursorType::kHand:
      return "pointer";
    case ui::mojom::CursorType::kIBeam:
      return "text";
    case ui::mojom::CursorType::kWait:
      return "wait";
    case ui::mojom::CursorType::kHelp:
      return "help";
    case ui::mojom::CursorType::kEastResize:
      return "e-resize";
    case ui::mojom::CursorType::kNorthResize:
      return "n-resize";
    case ui::mojom::CursorType::kNorthEastResize:
      return "ne-resize";
    case ui::mojom::CursorType::kNorthWestResize:
      return "nw-resize";
    case ui::mojom::CursorType::kSouthResize:
      return "s-resize";
    case ui::mojom::CursorType::kSouthEastResize:
      return "se-resize";
    case ui::mojom::CursorType::kSouthWestResize:
      return "sw-resize";
    case ui::mojom::CursorType::kWestResize:
      return "w-resize";
    case ui::mojom::CursorType::kNorthSouthResize:
      return "ns-resize";
    case ui::mojom::CursorType::kEastWestResize:
      return "ew-resize";
    case ui::mojom::CursorType::kNorthEastSouthWestResize:
      return "nesw-resize";
    case ui::mojom::CursorType::kNorthWestSouthEastResize:
      return "nwse-resize";
    case ui::mojom::CursorType::kColumnResize:
      return "col-resize";
    case ui::mojom::CursorType::kRowResize:
      return "row-resize";
    case ui::mojom::CursorType::kMiddlePanning:
      return "m-panning";
    case ui::mojom::CursorType::kEastPanning:
      return "e-panning";
    case ui::mojom::CursorType::kNorthPanning:
      return "n-panning";
    case ui::mojom::CursorType::kNorthEastPanning:
      return "ne-panning";
    case ui::mojom::CursorType::kNorthWestPanning:
      return "nw-panning";
    case ui::mojom::CursorType::kSouthPanning:
      return "s-panning";
    case ui::mojom::CursorType::kSouthEastPanning:
      return "se-panning";
    case ui::mojom::CursorType::kSouthWestPanning:
      return "sw-panning";
    case ui::mojom::CursorType::kWestPanning:
      return "w-panning";
    case ui::mojom::CursorType::kMove:
      return "move";
    case ui::mojom::CursorType::kVerticalText:
      return "vertical-text";
    case ui::mojom::CursorType::kCell:
      return "cell";
    case ui::mojom::CursorType::kContextMenu:
      return "context-menu";
    case ui::mojom::CursorType::kAlias:
      return "alias";
    case ui::mojom::CursorType::kProgress:
      return "progress";
    case ui::mojom::CursorType::kNoDrop:
      return "nodrop";
    case ui::mojom::CursorType::kCopy:
      return "copy";
    case ui::mojom::CursorType::kNone:
      return "none";
    case ui::mojom::CursorType::kNotAllowed:
      return "not-allowed";
    case ui::mojom::CursorType::kZoomIn:
      return "zoom-in";
    case ui::mojom::CursorType::kZoomOut:
      return "zoom-out";
    case ui::mojom::CursorType::kGrab:
      return "grab";
    case ui::mojom::CursorType::kGrabbing:
      return "grabbing";
    case ui::mojom::CursorType::kMiddlePanningVertical:
      return "m-panning-vertical";
    case ui::mojom::CursorType::kMiddlePanningHorizontal:
      return "m-panning-horizontal";
    case ui::mojom::CursorType::kCustom:
      return "custom";
    case ui::mojom::CursorType::kDndNone:
      return "drag-drop-none";
    case ui::mojom::CursorType::kDndMove:
      return "drag-drop-move";
    case ui::mojom::CursorType::kDndCopy:
      return "drag-drop-copy";
    case ui::mojom::CursorType::kDndLink:
      return "drag-drop-link";
    case ui::mojom::CursorType::kEastWestNoResize:
      return "ew-no-resize";
    case ui::mojom::CursorType::kNorthSouthNoResize:
      return "ns-no-resize";
    case ui::mojom::CursorType::kNorthEastSouthWestNoResize:
      return "nesw-no-resize";
    case ui::mojom::CursorType::kNorthWestSouthEastNoResize:
      return "nwse-no-resize";
  }
}

}  // namespace

base::DictValue ElectronKeyInput(const input::NativeWebKeyboardEvent& event) {
  const int modifiers = event.GetModifiers();
  const bool down = event.GetType() == WebInputEvent::Type::kRawKeyDown;
  CHECK(down || event.GetType() == WebInputEvent::Type::kKeyUp);
  const int location = (modifiers & WebInputEvent::kIsLeft)     ? 1
                       : (modifiers & WebInputEvent::kIsRight)  ? 2
                       : (modifiers & WebInputEvent::kIsKeyPad) ? 3
                                                                : 0;
  return base::DictValue()
      .Set("type", down ? "keyDown" : "keyUp")
      .Set("key",
           ui::KeycodeConverter::DomKeyToKeyString(ui::DomKey(event.dom_key)))
      .Set("code", ui::KeycodeConverter::DomCodeToCodeString(
                       static_cast<ui::DomCode>(event.dom_code)))
      .Set("is_auto_repeat", (modifiers & WebInputEvent::kIsAutoRepeat) != 0)
      .Set("is_composing", (modifiers & WebInputEvent::kIsComposing) != 0)
      .Set("shift", (modifiers & WebInputEvent::kShiftKey) != 0)
      .Set("control", (modifiers & WebInputEvent::kControlKey) != 0)
      .Set("alt", (modifiers & WebInputEvent::kAltKey) != 0)
      .Set("meta", (modifiers & WebInputEvent::kMetaKey) != 0)
      .Set("location", location)
      .Set("modifiers", ModifierList(modifiers));
}

base::DictValue ElectronInputEventValue(const WebInputEvent& event) {
  base::DictValue value;
  value.Set("type", TypeName(event.GetType()));
  value.Set("modifiers", ModifierList(event.GetModifiers()));
  if (WebInputEvent::IsKeyboardEventType(event.GetType())) {
    const auto& key = static_cast<const blink::WebKeyboardEvent&>(event);
    value.Set("key_code", ui::KeycodeConverter::DomKeyToKeyString(
                              ui::DomKey(key.dom_key)));
  } else if (event.GetType() == WebInputEvent::Type::kMouseWheel) {
    const auto& wheel = static_cast<const blink::WebMouseWheelEvent&>(event);
    AddMouse(value, wheel);
    value.Set("delta_x", wheel.delta_x);
    value.Set("delta_y", wheel.delta_y);
    value.Set("wheel_ticks_x", wheel.wheel_ticks_x);
    value.Set("wheel_ticks_y", wheel.wheel_ticks_y);
    value.Set("has_precise_scrolling_deltas",
              wheel.delta_units ==
                  ui::ScrollGranularity::kScrollByPrecisePixel);
  } else if (WebInputEvent::IsMouseEventType(event.GetType())) {
    AddMouse(value, static_cast<const blink::WebMouseEvent&>(event));
  }
  return value;
}

ElectronMadeInput ElectronMakeInput(
    const ElectronSyntheticInput& input,
    base::TimeTicks now) {
  return IsElectronKeyInput(input.type) ? MakeKey(input, now)
                                        : MakeMouse(input, now);
}

ElectronCursor ElectronCursorOf(const ui::Cursor& cursor) {
  ElectronCursor electron{.cursor = std::string(CursorName(cursor.type()))};
  if (cursor.type() == ui::mojom::CursorType::kCustom) {
    const SkBitmap& bitmap = cursor.custom_bitmap();
    // A bitmap the renderer sent and content checked; it encodes.
    const std::optional<std::vector<uint8_t>> png =
        gfx::PNGCodec::EncodeBGRASkBitmap(bitmap,
                                          /*discard_transparency=*/false);
    CHECK(png.has_value()) << "a page's custom cursor did not encode";
    electron.custom = ElectronCursor::Custom{
        .image = base::StrCat(
            {"data:image/png;base64,", base::Base64Encode(*png)}),
        .scale = cursor.image_scale_factor(),
        .width = bitmap.width(),
        .height = bitmap.height(),
        .hotspot_x = cursor.custom_hotspot().x(),
        .hotspot_y = cursor.custom_hotspot().y()};
  }
  return electron;
}

}  // namespace domicile
