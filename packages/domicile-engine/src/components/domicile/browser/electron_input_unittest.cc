// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_input.h"

#include <variant>

#include "base/time/time.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/cursor/cursor.h"
#include "ui/base/cursor/mojom/cursor_type.mojom-shared.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/point_f.h"

namespace domicile {
namespace {

using blink::WebInputEvent;

input::NativeWebKeyboardEvent MadeKey(const ElectronSyntheticInput& input) {
  return std::get<input::NativeWebKeyboardEvent>(
      ElectronMakeInput(input, base::TimeTicks()));
}

TEST(ElectronInputTest, AKeyIsBeforeInputEventsInput) {
  input::NativeWebKeyboardEvent key(
      WebInputEvent::Type::kRawKeyDown,
      WebInputEvent::kControlKey | WebInputEvent::kIsAutoRepeat,
      base::TimeTicks());
  key.dom_key = ui::DomKey::FromCharacter('a');
  key.dom_code = static_cast<int>(ui::DomCode::US_A);

  EXPECT_EQ(ElectronKeyInput(key),
            base::DictValue()
                .Set("type", "keyDown")
                .Set("key", "a")
                .Set("code", "KeyA")
                .Set("is_auto_repeat", true)
                .Set("is_composing", false)
                .Set("shift", false)
                .Set("control", true)
                .Set("alt", false)
                .Set("meta", false)
                .Set("location", 0)
                .Set("modifiers",
                     base::ListValue().Append("control").Append(
                         "isautorepeat")));
}

TEST(ElectronInputTest, AMouseEventHasItsPlaceAndButton) {
  blink::WebMouseEvent mouse(WebInputEvent::Type::kMouseDown,
                             gfx::PointF(10, 20), gfx::PointF(110, 220),
                             blink::WebMouseEvent::Button::kRight, 2,
                             WebInputEvent::kShiftKey, base::TimeTicks());

  EXPECT_EQ(ElectronInputEventValue(mouse),
            base::DictValue()
                .Set("type", "mouseDown")
                .Set("modifiers", base::ListValue().Append("shift"))
                .Set("x", 10.0)
                .Set("y", 20.0)
                .Set("global_x", 110.0)
                .Set("global_y", 220.0)
                .Set("movement_x", 0)
                .Set("movement_y", 0)
                .Set("click_count", 2)
                .Set("button", "right"));
}

TEST(ElectronInputTest, AnInputEventIsNamedAsElectronNamesIt) {
  EXPECT_EQ(*ElectronInputEventValue(
                 blink::WebMouseEvent(WebInputEvent::Type::kMouseMove, 0,
                                      base::TimeTicks()))
                 .FindString("type"),
            "mouseMove");
}

TEST(ElectronInputTest, ASentKeyDownIsARawKeyDownThatTypesNothing) {
  const input::NativeWebKeyboardEvent key = MadeKey(
      {.type = "keyDown", .modifiers = {"ctrl"}, .key_code = "Enter"});

  EXPECT_EQ(key.GetType(), WebInputEvent::Type::kRawKeyDown);
  EXPECT_EQ(key.GetModifiers(), WebInputEvent::kControlKey);
  EXPECT_EQ(key.windows_key_code, ui::VKEY_RETURN);
  EXPECT_EQ(key.dom_code, static_cast<int>(ui::DomCode::ENTER));
  EXPECT_EQ(ui::DomKey(key.dom_key), ui::DomKey::ENTER);
  EXPECT_EQ(key.text[0], u'\0');
}

TEST(ElectronInputTest, ASentCharTypesItsCharacterWithShiftWhenItNeedsIt) {
  const input::NativeWebKeyboardEvent key =
      MadeKey({.type = "char", .key_code = "?"});

  EXPECT_EQ(key.GetType(), WebInputEvent::Type::kChar);
  EXPECT_EQ(key.GetModifiers(), WebInputEvent::kShiftKey);
  EXPECT_EQ(key.windows_key_code, ui::VKEY_OEM_2);
  EXPECT_EQ(key.text[0], u'?');
}

TEST(ElectronInputTest, ASentKeyDomicileCannotNameIsUnknown) {
  const input::NativeWebKeyboardEvent key =
      MadeKey({.type = "keyDown", .key_code = "Hyper"});

  EXPECT_EQ(key.windows_key_code, ui::VKEY_UNKNOWN);
  EXPECT_EQ(ui::DomKey(key.dom_key), ui::DomKey::UNIDENTIFIED);
}

TEST(ElectronInputTest, ASentTabCharTypesATab) {
  EXPECT_EQ(MadeKey({.type = "char", .key_code = "Tab"}).text[0], u'\t');
}

TEST(ElectronInputTest, ASentMouseDownHoldsItsButton) {
  const auto made = ElectronMakeInput({.type = "mouseDown",
                                       .x = 5,
                                       .y = 6,
                                       .button = "middle",
                                       .click_count = 1},
                                      base::TimeTicks());

  const auto& mouse = std::get<blink::WebMouseEvent>(made);
  EXPECT_EQ(mouse.GetType(), WebInputEvent::Type::kMouseDown);
  EXPECT_EQ(mouse.PositionInWidget(), gfx::PointF(5, 6));
  // Without a global place, the page's.
  EXPECT_EQ(mouse.PositionInScreen(), gfx::PointF(5, 6));
  EXPECT_EQ(mouse.button, blink::WebMouseEvent::Button::kMiddle);
  EXPECT_NE(mouse.GetModifiers() & WebInputEvent::kMiddleButtonDown, 0);
}

TEST(ElectronInputTest, ASentMoveHoldsNoButton) {
  const auto made =
      ElectronMakeInput({.type = "mouseMove", .x = 5, .y = 6}, base::TimeTicks());

  const auto& mouse = std::get<blink::WebMouseEvent>(made);
  EXPECT_EQ(mouse.button, blink::WebMouseEvent::Button::kNoButton);
  EXPECT_EQ(mouse.GetModifiers() & WebInputEvent::kLeftButtonDown, 0);
}

TEST(ElectronInputTest, ASentWheelScrollsByItsDeltas) {
  const auto made = ElectronMakeInput({.type = "mouseWheel",
                                       .delta_y = -120,
                                       .has_precise_scrolling_deltas = true},
                                      base::TimeTicks());

  const auto& wheel = std::get<blink::WebMouseWheelEvent>(made);
  EXPECT_EQ(wheel.delta_y, -120);
  EXPECT_EQ(wheel.delta_units, ui::ScrollGranularity::kScrollByPrecisePixel);
}

TEST(ElectronInputTest, ACursorIsNamedAsElectronNamesIt) {
  EXPECT_EQ(ElectronCursorOf(ui::Cursor(ui::mojom::CursorType::kHand)),
            ElectronCursor{.cursor = "pointer"});
  EXPECT_EQ(ElectronCursorOf(ui::Cursor(ui::mojom::CursorType::kIBeam)),
            ElectronCursor{.cursor = "text"});
}

TEST(ElectronInputTest, ACustomCursorCarriesItsPictureAndHotspot) {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(4, 6);
  bitmap.eraseColor(SK_ColorRED);

  const ElectronCursor cursor = ElectronCursorOf(
      ui::Cursor::NewCustom(bitmap, gfx::Point(1, 2), /*image_scale_factor=*/2));

  EXPECT_EQ(cursor.cursor, "custom");
  ASSERT_TRUE(cursor.custom.has_value());
  EXPECT_TRUE(cursor.custom->image.starts_with("data:image/png;base64,"));
  EXPECT_EQ(cursor.custom->scale, 2);
  EXPECT_EQ(cursor.custom->width, 4);
  EXPECT_EQ(cursor.custom->height, 6);
  EXPECT_EQ(cursor.custom->hotspot_x, 1);
  EXPECT_EQ(cursor.custom->hotspot_y, 2);
}

}  // namespace
}  // namespace domicile
