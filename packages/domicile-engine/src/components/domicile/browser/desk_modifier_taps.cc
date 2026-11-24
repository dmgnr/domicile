// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_modifier_taps.h"

#include <algorithm>
#include <utility>

#include "base/check.h"
#include "base/no_destructor.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"

namespace domicile {
namespace {

// The event flag a modifier's keys set while held.
int FlagOf(TapModifier modifier) {
  switch (modifier) {
    case TapModifier::kAlt:
      return ui::EF_ALT_DOWN;
    case TapModifier::kCtrl:
      return ui::EF_CONTROL_DOWN;
    case TapModifier::kShift:
      return ui::EF_SHIFT_DOWN;
    case TapModifier::kMeta:
      return ui::EF_COMMAND_DOWN;
  }
}

constexpr int kModifierFlags = ui::EF_ALT_DOWN | ui::EF_CONTROL_DOWN |
                               ui::EF_SHIFT_DOWN | ui::EF_COMMAND_DOWN;

}  // namespace

std::optional<TapModifier> TapModifierOf(ui::DomCode code) {
  switch (code) {
    case ui::DomCode::ALT_LEFT:
    case ui::DomCode::ALT_RIGHT:
      return TapModifier::kAlt;
    case ui::DomCode::CONTROL_LEFT:
    case ui::DomCode::CONTROL_RIGHT:
      return TapModifier::kCtrl;
    case ui::DomCode::SHIFT_LEFT:
    case ui::DomCode::SHIFT_RIGHT:
      return TapModifier::kShift;
    case ui::DomCode::META_LEFT:
    case ui::DomCode::META_RIGHT:
      return TapModifier::kMeta;
    default:
      return std::nullopt;
  }
}

// static
DeskModifierTaps& DeskModifierTaps::Get() {
  static base::NoDestructor<DeskModifierTaps> taps;
  return *taps;
}

DeskModifierTaps::DeskModifierTaps() = default;
DeskModifierTaps::~DeskModifierTaps() = default;

DeskModifierTaps::ChannelId DeskModifierTaps::AddChannel(Tapped tapped) {
  base::AutoLock held(lock_);
  const ChannelId id = next_id_++;
  channels_.push_back(Channel{id, std::move(tapped), {}, false});
  return id;
}

void DeskModifierTaps::RemoveChannel(ChannelId channel) {
  base::AutoLock held(lock_);
  std::erase_if(channels_, [channel](const Channel& registered) {
    return registered.id == channel;
  });
}

void DeskModifierTaps::Grab(ChannelId channel,
                            TapModifier modifier,
                            bool while_inhibited,
                            base::TimeDelta longest) {
  base::AutoLock held(lock_);
  auto found = std::ranges::find(channels_, channel, &Channel::id);
  CHECK(found != channels_.end());
  auto grab = std::ranges::find(found->grabs, modifier, &Grabbed::modifier);
  if (grab == found->grabs.end()) {
    found->grabs.push_back(Grabbed{modifier, while_inhibited, longest});
  } else {
    grab->while_inhibited = while_inhibited;
    grab->longest = longest;
  }
}

void DeskModifierTaps::Ungrab(ChannelId channel, TapModifier modifier) {
  base::AutoLock held(lock_);
  auto found = std::ranges::find(channels_, channel, &Channel::id);
  CHECK(found != channels_.end());
  std::erase_if(found->grabs, [modifier](const Grabbed& grab) {
    return grab.modifier == modifier;
  });
}

void DeskModifierTaps::SetInhibited(ChannelId channel, bool inhibited) {
  base::AutoLock held(lock_);
  auto found = std::ranges::find(channels_, channel, &Channel::id);
  CHECK(found != channels_.end());
  found->inhibited = inhibited;
}

// static
ui::EventTypeSet DeskModifierTaps::Types() {
  return {ui::EventType::kKeyPressed,
          ui::EventType::kKeyReleased,
          ui::EventType::kMousePressed,
          ui::EventType::kMousewheel,
          ui::EventType::kScroll,
          ui::EventType::kScrollFlingStart,
          ui::EventType::kTouchPressed,
          ui::EventType::kGesturePinchBegin};
}

void DeskModifierTaps::Heard(const ui::Event& event) {
  Tapped tell;
  TapModifier tapped = TapModifier::kMeta;
  base::TimeDelta held;
  {
    base::AutoLock locked(lock_);
    if (!event.IsKeyEvent()) {
      pressed_.reset();
      return;
    }
    const ui::KeyEvent& key = *event.AsKeyEvent();
    const std::optional<TapModifier> modifier = TapModifierOf(key.code());
    if (key.type() == ui::EventType::kKeyPressed) {
      if (key.is_repeat() && pressed_ && pressed_->code == key.code()) {
        return;
      }
      // Pressed with no other modifier held. A modifier key's own press
      // carries its flag on some platforms and not on others.
      if (modifier &&
          (key.flags() & kModifierFlags & ~FlagOf(*modifier)) == 0 &&
          !key.is_repeat()) {
        pressed_ = Pressed{key.code(), key.time_stamp()};
      } else {
        pressed_.reset();
      }
      return;
    }
    // A release.
    if (!pressed_ || pressed_->code != key.code()) {
      // Another key coming up, as from a chord pressed before the modifier,
      // leaves the modifier alone.
      return;
    }
    held = key.time_stamp() - pressed_->at;
    pressed_.reset();
    tapped = *modifier;
    tell = Taker(tapped, held);
  }
  if (!tell.is_null()) {
    tell.Run(tapped, held);
  }
}

void DeskModifierTaps::Interrupt() {
  base::AutoLock held(lock_);
  pressed_.reset();
}

DeskModifierTaps::Tapped DeskModifierTaps::Taker(TapModifier modifier,
                                                 base::TimeDelta held) const {
  for (const Channel& channel : channels_) {
    auto grab = std::ranges::find(channel.grabs, modifier, &Grabbed::modifier);
    if (grab != channel.grabs.end() && held <= grab->longest &&
        (!channel.inhibited || grab->while_inhibited)) {
      return channel.tapped;
    }
  }
  return Tapped();
}

}  // namespace domicile
