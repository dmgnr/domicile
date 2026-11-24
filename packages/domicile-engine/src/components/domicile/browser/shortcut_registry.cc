// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shortcut_registry.h"

#include <algorithm>
#include <utility>

#include "base/check.h"
#include "base/logging.h"
#include "base/no_destructor.h"

namespace domicile {

// static
ShortcutRegistry& ShortcutRegistry::Get() {
  static base::NoDestructor<ShortcutRegistry> registry;
  return *registry;
}

ShortcutRegistry::ShortcutRegistry() = default;

ShortcutRegistry::~ShortcutRegistry() = default;

ShortcutRegistry::ChannelId ShortcutRegistry::AddChannel(
    Page page,
    ShortcutCallback on_shortcut,
    ShortcutCallback on_release,
    ModifiersCallback on_modifiers) {
  base::AutoLock held(lock_);
  const ChannelId id = next_id_++;
  channels_.push_back(Channel{id, page, std::move(on_shortcut),
                              std::move(on_release), std::move(on_modifiers)});
  return id;
}

void ShortcutRegistry::RemoveChannel(ChannelId channel) {
  base::AutoLock held(lock_);
  auto found = std::ranges::find(channels_, channel, &Channel::id);
  CHECK(found != channels_.end());
  const bool outgoing = found->outgoing;
  channels_.erase(found);
  if (outgoing) {
    std::erase_if(grabbed_, [channel](const Claim& claim) {
      return claim.channel == channel;
    });
    return;
  }
  std::vector<Claim> kept;
  for (const Claim& claim : grabbed_) {
    const Claim left_over{claim.chord,
                          claim.channel == channel ? kLeftOver : claim.channel};
    if (std::ranges::find(kept, left_over) == kept.end()) {
      kept.push_back(left_over);
    }
  }
  grabbed_ = std::move(kept);
}

void ShortcutRegistry::ShellChanged() {
  base::AutoLock held(lock_);
  std::erase_if(grabbed_,
                [](const Claim& claim) { return claim.channel == kLeftOver; });
  for (Channel& channel : channels_) {
    channel.outgoing = true;
  }
}

void ShortcutRegistry::Grab(ChannelId channel, const Chord& chord) {
  base::AutoLock held(lock_);
  const Claim claim{chord, channel};
  if (std::ranges::find(grabbed_, claim) == grabbed_.end()) {
    grabbed_.push_back(claim);
  }
}

void ShortcutRegistry::Ungrab(ChannelId channel, const Chord& chord) {
  base::AutoLock held(lock_);
  std::erase_if(grabbed_, [channel, &chord](const Claim& claim) {
    return claim.chord == chord &&
           (claim.channel == channel || claim.channel == kLeftOver);
  });
}

bool ShortcutRegistry::Press(const Chord& chord, const Page& page) {
  // Run callbacks outside the lock, since a callback may re-enter the
  // registry.
  std::vector<ShortcutCallback> tell;
  {
    base::AutoLock held(lock_);
    if (!IsGrabbed(chord)) {
      return false;
    }
    for (const Channel& channel : channels_) {
      if (channel.page == page) {
        tell.push_back(channel.on_shortcut);
      }
    }
  }

  // The key is still swallowed, since the claim is process-wide. Warn because
  // nothing handles it.
  LOG_IF(WARNING, tell.empty())
      << "domicile: a claimed chord was pressed in a page with no control "
         "channel; nothing answers it";
  for (const ShortcutCallback& channel : tell) {
    channel.Run(chord);
  }
  return true;
}

void ShortcutRegistry::Release(const Chord& chord,
                               bool modifier,
                               const Page& page) {
  std::vector<ShortcutCallback> tell;
  {
    base::AutoLock held(lock_);
    if (!IsGrabbedKey(chord.keycode) && !modifier) {
      return;
    }
    for (const Channel& channel : channels_) {
      if (channel.page == page) {
        tell.push_back(channel.on_release);
      }
    }
  }

  for (const ShortcutCallback& channel : tell) {
    channel.Run(chord);
  }
}

bool ShortcutRegistry::IsGrabbed(const Chord& chord) const {
  return std::ranges::any_of(
      grabbed_, [&chord](const Claim& claim) { return claim.chord == chord; });
}

bool ShortcutRegistry::IsGrabbedKey(uint32_t keycode) const {
  return std::ranges::any_of(grabbed_, [keycode](const Claim& claim) {
    return claim.chord.keycode == keycode;
  });
}

void ShortcutRegistry::SetModifiers(const Modifiers& modifiers) {
  std::vector<ModifiersCallback> tell;
  {
    base::AutoLock held(lock_);
    if (reported_.has_value() && *reported_ == modifiers) {
      return;
    }
    reported_ = modifiers;
    tell.reserve(channels_.size());
    for (const Channel& channel : channels_) {
      tell.push_back(channel.on_modifiers);
    }
  }

  for (const ModifiersCallback& channel : tell) {
    channel.Run(modifiers);
  }
}

}  // namespace domicile
