// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_DESK_MODIFIER_TAPS_H_
#define COMPONENTS_DOMICILE_BROWSER_DESK_MODIFIER_TAPS_H_

#include <stdint.h>

#include <optional>
#include <vector>

#include "base/functional/callback.h"
#include "base/synchronization/lock.h"
#include "base/thread_annotations.h"
#include "base/time/time.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/types/event_type.h"

namespace ui {
class Event;
}  // namespace ui

namespace domicile {

// A modifier the shell can bind a tap of: pressed and let go alone. Either
// side's key taps it.
enum class TapModifier { kAlt, kCtrl, kShift, kMeta };

// The modifier taps the shell grabbed, and who to tell when one happens.
//
// A tap is a modifier key pressed with no other modifier held, then released
// with nothing in between: no other key, pointer button, scroll, pinch or
// touch, and no touchpad gesture the shell took. So `Meta` tapped opens the
// overview, while `Meta+Return` or `Meta`-dragging a window does not. A held
// modifier's own repeats do not cancel it. Held longer than its grab's
// `longest`, it is no tap: Super held, thought better of and let go does
// nothing.
//
// Every key, click and scroll on the desk passes aura in the browser process
// before it reaches the shell page, a `<webview>` guest or a native window, so
// this hears them all there (`StartModifierTaps`). A tap goes to the first
// channel grabbing it: each page grabs the same taps, and telling every page
// would run a binding once per monitor.
//
// While a channel's keyboard window holds a shortcuts inhibitor (a VM, a
// remote desktop viewer), its taps are the window's, as its chords are,
// unless it grabbed the tap `while_inhibited`.
//
// Grabs arrive on a `ControlChannel` on the IO thread, events on the UI
// thread and touchpad gestures on the platform's input thread, hence the
// lock. Callers wrap callbacks with `base::BindPostTask`: they run on the
// thread an event arrives on, and never under the lock.
class DeskModifierTaps {
 public:
  // The modifier tapped, and how long it was held.
  using Tapped = base::RepeatingCallback<void(TapModifier, base::TimeDelta)>;

  // Handle for removing a channel. Never zero.
  using ChannelId = uint64_t;

  // The process-wide one. Tests build their own instead.
  static DeskModifierTaps& Get();

  DeskModifierTaps();
  DeskModifierTaps(const DeskModifierTaps&) = delete;
  DeskModifierTaps& operator=(const DeskModifierTaps&) = delete;
  ~DeskModifierTaps();

  // A page that can grab taps, told each one it grabbed.
  ChannelId AddChannel(Tapped tapped);

  // Drops `channel` and its grabs.
  void RemoveChannel(ChannelId channel);

  // `channel` takes taps of `modifier` held no longer than `longest`, even
  // under a shortcuts inhibitor if `while_inhibited`. A second grab sets both
  // anew: the page counts its own grabs under every name, `Meta` or `Super`,
  // and sends what they add up to.
  void Grab(ChannelId channel,
            TapModifier modifier,
            bool while_inhibited,
            base::TimeDelta longest);

  // `channel` gives taps of `modifier` back.
  void Ungrab(ChannelId channel, TapModifier modifier);

  // Whether `channel`'s keyboard window holds a shortcuts inhibitor.
  void SetInhibited(ChannelId channel, bool inhibited);

  // The events `Heard` wants: keys, clicks, scrolls, pinches and touches.
  static ui::EventTypeSet Types();

  // An event on the desk: a key, click, scroll, pinch or touch.
  void Heard(const ui::Event& event);

  // Something no event shows used the held modifier: a touchpad gesture the
  // shell took.
  void Interrupt();

 private:
  struct Grabbed {
    TapModifier modifier;
    bool while_inhibited = false;
    base::TimeDelta longest;
  };

  // A modifier key pressed alone, and when.
  struct Pressed {
    ui::DomCode code;
    base::TimeTicks at;
  };

  struct Channel {
    ChannelId id = 0;
    Tapped tapped;
    std::vector<Grabbed> grabs;
    bool inhibited = false;
  };

  // The first taker of a tap of `modifier` held `held`, or a null callback.
  Tapped Taker(TapModifier modifier, base::TimeDelta held) const
      EXCLUSIVE_LOCKS_REQUIRED(lock_);

  base::Lock lock_;
  ChannelId next_id_ GUARDED_BY(lock_) = 1;
  std::vector<Channel> channels_ GUARDED_BY(lock_);
  // The modifier key pressed alone, until it comes up or something uses it.
  std::optional<Pressed> pressed_ GUARDED_BY(lock_);
};

// The modifier `code` is a key of, if it is one.
std::optional<TapModifier> TapModifierOf(ui::DomCode code);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_DESK_MODIFIER_TAPS_H_
