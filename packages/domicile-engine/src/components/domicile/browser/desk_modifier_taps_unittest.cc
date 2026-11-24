// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_modifier_taps.h"

#include <vector>

#include "base/functional/bind.h"
#include "base/time/time.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/events/types/event_type.h"
#include "ui/gfx/geometry/point_f.h"

namespace domicile {
namespace {

using ui::DomCode;
using Heard = std::vector<TapModifier>;

constexpr base::TimeDelta kLongest = base::Milliseconds(300);

DeskModifierTaps::Tapped Into(Heard* heard) {
  return base::BindRepeating(
      [](Heard* heard, TapModifier modifier, base::TimeDelta) {
        heard->push_back(modifier);
      },
      base::Unretained(heard));
}

ui::KeyboardCode KeyboardCodeOf(DomCode code) {
  switch (code) {
    case DomCode::META_LEFT:
      return ui::VKEY_LWIN;
    case DomCode::META_RIGHT:
      return ui::VKEY_RWIN;
    case DomCode::SHIFT_LEFT:
    case DomCode::SHIFT_RIGHT:
      return ui::VKEY_SHIFT;
    case DomCode::CONTROL_LEFT:
    case DomCode::CONTROL_RIGHT:
      return ui::VKEY_CONTROL;
    case DomCode::ALT_LEFT:
    case DomCode::ALT_RIGHT:
      return ui::VKEY_MENU;
    case DomCode::US_A:
      return ui::VKEY_A;
    default:
      return ui::VKEY_RETURN;
  }
}

// Every key event at one instant, unless a test says when.
const base::TimeTicks kStart = base::TimeTicks() + base::Seconds(1);

ui::KeyEvent KeyAt(ui::EventType type,
                   DomCode code,
                   int flags,
                   base::TimeTicks at) {
  return ui::KeyEvent(type, KeyboardCodeOf(code), code, flags, at);
}

ui::KeyEvent Press(DomCode code,
                   int flags = ui::EF_NONE,
                   base::TimeTicks at = kStart) {
  return KeyAt(ui::EventType::kKeyPressed, code, flags, at);
}

ui::KeyEvent Release(DomCode code,
                     int flags = ui::EF_NONE,
                     base::TimeTicks at = kStart) {
  return KeyAt(ui::EventType::kKeyReleased, code, flags, at);
}

ui::MouseEvent Click() {
  return ui::MouseEvent(ui::EventType::kMousePressed, gfx::PointF(10, 10),
                        gfx::PointF(10, 10), base::TimeTicks::Now(),
                        ui::EF_LEFT_MOUSE_BUTTON | ui::EF_COMMAND_DOWN,
                        ui::EF_LEFT_MOUSE_BUTTON);
}

ui::ScrollEvent Scroll() {
  return ui::ScrollEvent(ui::EventType::kScroll, gfx::PointF(10, 10),
                         gfx::PointF(10, 10), base::TimeTicks::Now(),
                         ui::EF_COMMAND_DOWN, 0, 12, 0, 12, 2);
}

class DeskModifierTapsTest : public testing::Test {
 protected:
  DeskModifierTapsTest() : channel_(taps_.AddChannel(Into(&heard_))) {
    taps_.Grab(channel_, TapModifier::kMeta, false, kLongest);
  }

  void Tap(DomCode code) {
    taps_.Heard(Press(code));
    taps_.Heard(Release(code));
  }

  DeskModifierTaps taps_;
  Heard heard_;
  DeskModifierTaps::ChannelId channel_;
};

// Super pressed and let go alone is a tap of `Meta`, from either key.
TEST_F(DeskModifierTapsTest, EitherSuperKeyTapsMeta) {
  Tap(DomCode::META_LEFT);
  Tap(DomCode::META_RIGHT);

  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta, TapModifier::kMeta}));
}

// The press of a modifier key may carry its own flag.
TEST_F(DeskModifierTapsTest, APressCarryingItsOwnFlagStillTaps) {
  taps_.Heard(Press(DomCode::META_LEFT, ui::EF_COMMAND_DOWN));
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));
}

// `Meta+Return` is a chord, not a tap.
TEST_F(DeskModifierTapsTest, AnotherKeyMakesItAChord) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Press(DomCode::ENTER, ui::EF_COMMAND_DOWN));
  taps_.Heard(Release(DomCode::ENTER, ui::EF_COMMAND_DOWN));
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_TRUE(heard_.empty());
}

// `Shift+Meta` held together is no tap of either.
TEST_F(DeskModifierTapsTest, AnotherModifierHeldIsNoTap) {
  taps_.Heard(Press(DomCode::SHIFT_LEFT));
  taps_.Heard(Press(DomCode::META_LEFT, ui::EF_SHIFT_DOWN));
  taps_.Heard(Release(DomCode::META_LEFT, ui::EF_SHIFT_DOWN));
  taps_.Heard(Release(DomCode::SHIFT_LEFT));

  EXPECT_TRUE(heard_.empty());
}

// A modifier pressed after Super uses it too.
TEST_F(DeskModifierTapsTest, AModifierPressedAfterIsNoTap) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Press(DomCode::SHIFT_LEFT, ui::EF_COMMAND_DOWN));
  taps_.Heard(Release(DomCode::SHIFT_LEFT, ui::EF_COMMAND_DOWN));
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_TRUE(heard_.empty());
}

// Super-dragging a window or Super-scrolling to zoom the desk is no tap.
TEST_F(DeskModifierTapsTest, AClickOrScrollIsNoTap) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Click());
  taps_.Heard(Release(DomCode::META_LEFT));
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Scroll());
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_TRUE(heard_.empty());
}

// A touchpad gesture the shell took, which no aura event shows.
TEST_F(DeskModifierTapsTest, AnInterruptionIsNoTap) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Interrupt();
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_TRUE(heard_.empty());
}

// Holding Super repeats its press; letting go is still a tap.
TEST_F(DeskModifierTapsTest, ItsOwnRepeatsKeepTheTap) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Press(DomCode::META_LEFT, ui::EF_IS_REPEAT));
  taps_.Heard(Release(DomCode::META_LEFT));

  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));
}

// A tap nobody grabbed goes nowhere.
TEST_F(DeskModifierTapsTest, AnUngrabbedModifierTapsNobody) {
  Tap(DomCode::SHIFT_LEFT);
  taps_.Ungrab(channel_, TapModifier::kMeta);
  Tap(DomCode::META_LEFT);

  EXPECT_TRUE(heard_.empty());
}

// Every page grabs the same taps; one running the binding is enough.
TEST_F(DeskModifierTapsTest, OnlyTheFirstTakerHearsATap) {
  Heard second;
  const auto two = taps_.AddChannel(Into(&second));
  taps_.Grab(two, TapModifier::kMeta, false, kLongest);

  Tap(DomCode::META_LEFT);
  taps_.RemoveChannel(channel_);
  Tap(DomCode::META_LEFT);

  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));
  EXPECT_EQ(second, (Heard{TapModifier::kMeta}));
}

// A VM holding a shortcuts inhibitor gets Super, unless the grab said
// `--inhibited`.
TEST_F(DeskModifierTapsTest, AnInhibitorTakesTapsNotGrabbedWhileInhibited) {
  taps_.SetInhibited(channel_, true);
  Tap(DomCode::META_LEFT);
  EXPECT_TRUE(heard_.empty());

  taps_.Grab(channel_, TapModifier::kMeta, true, kLongest);
  Tap(DomCode::META_LEFT);
  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));

  // The page gave back the grab that said `--inhibited`.
  taps_.Grab(channel_, TapModifier::kMeta, false, kLongest);
  Tap(DomCode::META_LEFT);
  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));
}

// Super held a while and let go alone is no tap; held up to the grab's
// longest still is.
TEST_F(DeskModifierTapsTest, AHoldLongerThanTheGrabsLongestIsNoTap) {
  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Release(DomCode::META_LEFT, ui::EF_NONE,
                      kStart + kLongest + base::Milliseconds(1)));
  EXPECT_TRUE(heard_.empty());

  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Release(DomCode::META_LEFT, ui::EF_NONE, kStart + kLongest));
  EXPECT_EQ(heard_, (Heard{TapModifier::kMeta}));
}

// The page hears how long the modifier was held, to match each name it
// grabbed the tap by against that name's longest.
TEST_F(DeskModifierTapsTest, ATapSaysHowLongItWasHeld) {
  std::vector<base::TimeDelta> held;
  taps_.RemoveChannel(channel_);
  const auto timed = taps_.AddChannel(base::BindRepeating(
      [](std::vector<base::TimeDelta>* held, TapModifier,
         base::TimeDelta duration) { held->push_back(duration); },
      base::Unretained(&held)));
  taps_.Grab(timed, TapModifier::kMeta, false, kLongest);

  taps_.Heard(Press(DomCode::META_LEFT));
  taps_.Heard(Release(DomCode::META_LEFT, ui::EF_NONE,
                      kStart + base::Milliseconds(120)));

  EXPECT_EQ(held, (std::vector<base::TimeDelta>{base::Milliseconds(120)}));
}

TEST(TapModifierOfTest, NamesTheModifierOfEachSidesKey) {
  EXPECT_EQ(TapModifierOf(DomCode::ALT_RIGHT), TapModifier::kAlt);
  EXPECT_EQ(TapModifierOf(DomCode::CONTROL_LEFT), TapModifier::kCtrl);
  EXPECT_EQ(TapModifierOf(DomCode::SHIFT_RIGHT), TapModifier::kShift);
  EXPECT_EQ(TapModifierOf(DomCode::META_RIGHT), TapModifier::kMeta);
  EXPECT_EQ(TapModifierOf(DomCode::US_A), std::nullopt);
}

}  // namespace
}  // namespace domicile
