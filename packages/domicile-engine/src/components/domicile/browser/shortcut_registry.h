// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHORTCUT_REGISTRY_H_
#define COMPONENTS_DOMICILE_BROWSER_SHORTCUT_REGISTRY_H_

#include <stdint.h>

#include <optional>
#include <vector>

#include "base/functional/callback.h"
#include "base/synchronization/lock.h"
#include "base/thread_annotations.h"

namespace domicile {

// A key combination the desktop has claimed for itself.
//
// `keycode` is a Linux evdev code, as used by the control protocol. The XKB
// keycode in a Wayland keymap is this plus 8.
struct Chord {
  uint32_t keycode = 0;
  bool alt = false;
  bool ctrl = false;
  bool shift = false;
  bool meta = false;

  friend bool operator==(const Chord&, const Chord&) = default;
};

// Which modifiers the keyboard holds.
//
// Resolved booleans rather than XKB masks, because a page cannot read a mask
// without the keymap.
struct Modifiers {
  bool alt = false;
  bool ctrl = false;
  bool shift = false;
  bool meta = false;

  friend bool operator==(const Modifiers&, const Modifiers&) = default;
};

// A shell page, identified by render process id and frame id. Plain ints
// rather than content's id keep this a //base target that unit tests can build
// without a browser.
struct Page {
  int process = 0;
  int frame = 0;

  friend bool operator==(const Page&, const Page&) = default;
};

// The chords the shell claimed for the desktop, and who to tell when one fires.
//
// This lives in the browser process because a focused `<webview>` guest's keys
// never reach the shell document or the compositor. The browser process is
// the only layer above a focused guest.
// WebViewGuest::PreHandleKeyboardEvent is where a key meets these.
//
// Claims arrive on a `ControlChannel` on the IO thread; key presses arrive on
// the UI thread, hence the lock. Callers must wrap callbacks with
// `base::BindPostTask`: they run on whichever sequence a press arrives on, and
// never under the lock.
//
// Each page claims for itself, and a chord is the desktop's while any page
// claims it. A press is delivered only to the page that heard it. Every page
// claims the same chords, so telling every page would run the shortcut once
// per monitor.
class ShortcutRegistry {
 public:
  using ShortcutCallback = base::RepeatingCallback<void(Chord)>;
  using ModifiersCallback = base::RepeatingCallback<void(Modifiers)>;

  // Handle for removing a channel. Never zero.
  using ChannelId = uint64_t;

  // The process-wide registry. Tests build their own instead.
  static ShortcutRegistry& Get();

  ShortcutRegistry();

  ShortcutRegistry(const ShortcutRegistry&) = delete;
  ShortcutRegistry& operator=(const ShortcutRegistry&) = delete;

  ~ShortcutRegistry();

  // Starts delivering to `page`. Callbacks may run on any sequence, so wrap
  // them to post back to the caller's.
  ChannelId AddChannel(Page page,
                       ShortcutCallback on_shortcut,
                       ShortcutCallback on_release,
                       ModifiersCallback on_modifiers);

  // Stops delivering to `channel`. Its claims stay, left over, so a reloading
  // page leaves no gap in which a chord reaches the focused window. Unless the
  // shell changed while it was open: then its claims go with it.
  void RemoveChannel(ChannelId channel);

  // The desktop is switching to another shell (`domicile load-shell`). Drops
  // the claims closed pages left over, and has every page open now drop its
  // claims when it closes instead of leaving them.
  void ShellChanged();

  // Claims `chord` for the desktop on behalf of `channel`. Idempotent, so the
  // shell can re-run its claims.
  void Grab(ChannelId channel, const Chord& chord);

  // Drops `channel`'s claim on `chord`, and any claim on it a closed page left
  // over: a page letting go is the shell letting go. Another open page's claim
  // stays. Idempotent.
  void Ungrab(ChannelId channel, const Chord& chord);

  // Handles a key press in a `<webview>` of `page`. If `chord` is claimed,
  // notifies that page's channels and returns true; the caller must then
  // swallow the key.
  bool Press(const Chord& chord, const Page& page);

  // Handles a key release in a `<webview>` of `page`: `chord` is the key that
  // came up and the modifiers still held, and `modifier` whether the layout
  // makes that key a modifier. Tells that page's channels when the key is a
  // claimed chord's or a modifier, either of which can let go of a chord the
  // page holds; the page pairs it with the press. The key is not swallowed.
  void Release(const Chord& chord, bool modifier, const Page& page);

  // Reports the held modifiers. Delivered only on change (and the first
  // time), so holding Alt while typing does not repeat it per key.
  void SetModifiers(const Modifiers& modifiers);

 private:
  // Whether `chord` is claimed.
  bool IsGrabbed(const Chord& chord) const EXCLUSIVE_LOCKS_REQUIRED(lock_);

  // Whether a claimed chord is on `keycode`.
  bool IsGrabbedKey(uint32_t keycode) const EXCLUSIVE_LOCKS_REQUIRED(lock_);

  // A page's claim on `chord`; `channel` is kLeftOver once its page is gone.
  struct Claim {
    Chord chord;
    ChannelId channel;

    friend bool operator==(const Claim&, const Claim&) = default;
  };
  static constexpr ChannelId kLeftOver = 0;

  struct Channel {
    ChannelId id;
    Page page;
    ShortcutCallback on_shortcut;
    ShortcutCallback on_release;
    ModifiersCallback on_modifiers;
    // Opened before the last ShellChanged: the old shell's page.
    bool outgoing = false;
  };

  base::Lock lock_;
  std::vector<Claim> grabbed_ GUARDED_BY(lock_);
  std::vector<Channel> channels_ GUARDED_BY(lock_);
  std::optional<Modifiers> reported_ GUARDED_BY(lock_);
  ChannelId next_id_ GUARDED_BY(lock_) = 1;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHORTCUT_REGISTRY_H_
