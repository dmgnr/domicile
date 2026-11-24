// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shortcut_registry.h"

#include <memory>
#include <vector>

#include "base/functional/bind.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// Evdev keycodes.
constexpr uint32_t kTab = 15;
constexpr uint32_t kEnter = 28;
constexpr uint32_t kA = 30;
constexpr uint32_t kLeftAlt = 56;
constexpr uint32_t kCapsLock = 58;

Chord AltTab() {
  return Chord{kTab, /*alt=*/true, /*ctrl=*/false, /*shift=*/false,
               /*meta=*/false};
}

// Shell pages on two monitors.
constexpr Page kLeft{/*process=*/1, /*frame=*/1};
constexpr Page kRight{/*process=*/2, /*frame=*/1};

// A channel that records what it receives. Uses a registry on the stack so
// tests do not share the singleton.
class RecordingChannel {
 public:
  explicit RecordingChannel(ShortcutRegistry& registry, Page page = kLeft)
      : id_(registry.AddChannel(
            page,
            base::BindRepeating(&RecordingChannel::OnShortcut,
                                base::Unretained(this)),
            base::BindRepeating(&RecordingChannel::OnRelease,
                                base::Unretained(this)),
            base::BindRepeating(&RecordingChannel::OnModifiers,
                                base::Unretained(this)))) {}

  ShortcutRegistry::ChannelId id() const { return id_; }
  const std::vector<Chord>& presses() const { return presses_; }
  const std::vector<Chord>& releases() const { return releases_; }
  const std::vector<Modifiers>& modifiers() const { return modifiers_; }

 private:
  void OnShortcut(Chord chord) { presses_.push_back(chord); }
  void OnRelease(Chord chord) { releases_.push_back(chord); }
  void OnModifiers(Modifiers modifiers) { modifiers_.push_back(modifiers); }

  ShortcutRegistry::ChannelId id_;
  std::vector<Chord> presses_;
  std::vector<Chord> releases_;
  std::vector<Modifiers> modifiers_;
};

TEST(ShortcutRegistryTest, AKeyNobodyClaimedIsNotTheDesktops) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);

  EXPECT_FALSE(registry.Press(AltTab(), kLeft));
  EXPECT_TRUE(channel.presses().empty());
}

TEST(ShortcutRegistryTest, AClaimedChordFiresOnTheChannelThatClaimedIt) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());

  EXPECT_TRUE(registry.Press(AltTab(), kLeft));
  ASSERT_EQ(1u, channel.presses().size());
  EXPECT_EQ(AltTab(), channel.presses()[0]);
}

// A claim matches the exact modifier set. Ctrl+Alt+Enter is not claimed by
// Alt+Enter and must reach the page.
TEST(ShortcutRegistryTest, AChordIsEveryModifierAndNotJustTheKey) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());

  EXPECT_FALSE(registry.Press(
      Chord{kTab, /*alt=*/false, /*ctrl=*/false, /*shift=*/false,
            /*meta=*/false},
      kLeft));
  EXPECT_FALSE(registry.Press(
      Chord{kTab, /*alt=*/true, /*ctrl=*/false, /*shift=*/true,
            /*meta=*/false},
      kLeft));
  EXPECT_FALSE(registry.Press(
      Chord{kEnter, /*alt=*/true, /*ctrl=*/false, /*shift=*/false,
            /*meta=*/false},
      kLeft));
  EXPECT_TRUE(channel.presses().empty());
}

// The protocol makes duplicate claims one claim. A shell re-runs its claiming
// effect whenever its callbacks change.
TEST(ShortcutRegistryTest, ClaimingOneChordTwiceIsOneClaim) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());
  registry.Grab(channel.id(), AltTab());

  EXPECT_TRUE(registry.Press(AltTab(), kLeft));
  EXPECT_EQ(1u, channel.presses().size());
}

// A removed channel's callback may point at freed memory.
TEST(ShortcutRegistryTest, AChannelThatLeftIsToldNothing) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());
  registry.RemoveChannel(channel.id());

  // The claim outlives the channel, so a reload does not hand chords back to
  // the focused page.
  EXPECT_TRUE(registry.Press(AltTab(), kLeft));
  EXPECT_TRUE(channel.presses().empty());
}

// Each monitor has its own page. Telling every page would run one press once
// per monitor (e.g. one terminal per monitor).
TEST(ShortcutRegistryTest, AChordIsToldOnlyToThePageThatHeardIt) {
  ShortcutRegistry registry;
  RecordingChannel left(registry, kLeft);
  RecordingChannel right(registry, kRight);
  registry.Grab(left.id(), AltTab());

  EXPECT_TRUE(registry.Press(AltTab(), kRight));
  EXPECT_TRUE(left.presses().empty());
  EXPECT_EQ(1u, right.presses().size());
}

// A chord's key or modifier coming up in a guest lets go of the chord, which
// may have been pressed on the page. Only the page that heard it is told.
TEST(ShortcutRegistryTest, AClaimedKeyOrAModifierComingUpIsToldToItsPage) {
  ShortcutRegistry registry;
  RecordingChannel left(registry, kLeft);
  RecordingChannel right(registry, kRight);
  registry.Grab(left.id(), AltTab());
  const Chord tab_up{kTab, /*alt=*/true, /*ctrl=*/false, /*shift=*/false,
                     /*meta=*/false};
  const Chord alt_up{kLeftAlt, /*alt=*/false, /*ctrl=*/false,
                     /*shift=*/false, /*meta=*/false};

  registry.Release(tab_up, /*modifier=*/false, kLeft);
  registry.Release(alt_up, /*modifier=*/true, kLeft);

  EXPECT_EQ(left.releases(), (std::vector{tab_up, alt_up}));
  EXPECT_TRUE(right.releases().empty());
}

// A modifier is the layout's, not the key's: with `ctrl:nocaps`, Caps Lock
// coming up lets go of a Ctrl chord.
TEST(ShortcutRegistryTest, AKeyTheLayoutMakesAModifierComingUpIsTold) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());
  const Chord caps_up{kCapsLock, /*alt=*/false, /*ctrl=*/false,
                      /*shift=*/false, /*meta=*/false};

  registry.Release(caps_up, /*modifier=*/true, kLeft);

  EXPECT_EQ(channel.releases(), (std::vector{caps_up}));
}

// A shell lets go of a chord it no longer binds, and the key reaches the site
// again.
TEST(ShortcutRegistryTest, AnUngrabbedChordIsTheSitesAgain) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());

  registry.Ungrab(channel.id(), AltTab());

  EXPECT_FALSE(registry.Press(AltTab(), kLeft));
  EXPECT_TRUE(channel.presses().empty());
}

// Each monitor's page claims for itself, so one letting go leaves the other's
// claim, and its `<webview>`s still give the chord up.
TEST(ShortcutRegistryTest, AChordStaysClaimedWhileAnotherPageClaimsIt) {
  ShortcutRegistry registry;
  RecordingChannel left(registry, kLeft);
  RecordingChannel right(registry, kRight);
  registry.Grab(left.id(), AltTab());
  registry.Grab(right.id(), AltTab());

  registry.Ungrab(left.id(), AltTab());

  EXPECT_TRUE(registry.Press(AltTab(), kRight));
  EXPECT_EQ(1u, right.presses().size());
}

// A page that reloaded left its claims behind. Its successor letting go of the
// chord is the shell letting go, so the left-over claim goes too.
TEST(ShortcutRegistryTest, LettingGoAlsoReleasesWhatAClosedPageLeft) {
  ShortcutRegistry registry;
  auto reloaded = std::make_unique<RecordingChannel>(registry);
  registry.Grab(reloaded->id(), AltTab());
  registry.RemoveChannel(reloaded->id());
  reloaded.reset();
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());

  registry.Ungrab(channel.id(), AltTab());

  EXPECT_FALSE(registry.Press(AltTab(), kLeft));
}

// `domicile load-shell` to another shell: what the old one left over is not
// the new one's.
TEST(ShortcutRegistryTest, AnotherShellDropsWhatAClosedPageLeft) {
  ShortcutRegistry registry;
  auto old_shell = std::make_unique<RecordingChannel>(registry);
  registry.Grab(old_shell->id(), AltTab());
  registry.RemoveChannel(old_shell->id());
  old_shell.reset();

  registry.ShellChanged();

  EXPECT_FALSE(registry.Press(AltTab(), kLeft));
}

// The old shell's page is still open when the swap starts. Its claims hold
// until it closes, then go with it.
TEST(ShortcutRegistryTest, AnotherShellDropsTheOpenPagesClaimsOnceItCloses) {
  ShortcutRegistry registry;
  auto old_shell = std::make_unique<RecordingChannel>(registry);
  registry.Grab(old_shell->id(), AltTab());

  registry.ShellChanged();
  EXPECT_TRUE(registry.Press(AltTab(), kLeft));

  registry.RemoveChannel(old_shell->id());
  old_shell.reset();
  EXPECT_FALSE(registry.Press(AltTab(), kLeft));
}

// The new shell's page opened after the change, so its reloads leave claims as
// before.
TEST(ShortcutRegistryTest, TheNewShellsPagesStillLeaveTheirClaims) {
  ShortcutRegistry registry;
  registry.ShellChanged();
  auto new_shell = std::make_unique<RecordingChannel>(registry);
  registry.Grab(new_shell->id(), AltTab());

  registry.RemoveChannel(new_shell->id());
  new_shell.reset();

  EXPECT_TRUE(registry.Press(AltTab(), kLeft));
}

// Every key typed into a site would otherwise cross to the shell.
TEST(ShortcutRegistryTest, AnyOtherKeyComingUpIsNotTold) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  registry.Grab(channel.id(), AltTab());

  registry.Release(Chord{kA, /*alt=*/true, /*ctrl=*/false, /*shift=*/false,
                         /*meta=*/false},
                   /*modifier=*/false, kLeft);

  EXPECT_TRUE(channel.releases().empty());
}

// The shell re-renders on each report, so a repeated set is not resent.
TEST(ShortcutRegistryTest, ModifiersAreReportedWhenTheyChangeAndNotOtherwise) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);
  const Modifiers alt_held{/*alt=*/true, /*ctrl=*/false, /*shift=*/false,
                           /*meta=*/false};
  const Modifiers nothing_held{/*alt=*/false, /*ctrl=*/false, /*shift=*/false,
                               /*meta=*/false};

  registry.SetModifiers(alt_held);
  registry.SetModifiers(alt_held);
  registry.SetModifiers(nothing_held);

  ASSERT_EQ(2u, channel.modifiers().size());
  EXPECT_EQ(alt_held, channel.modifiers()[0]);
  EXPECT_EQ(nothing_held, channel.modifiers()[1]);
}

// The shell assumes nothing is held until told. Suppressing the first report
// would drop the first Alt, which starts a drag.
TEST(ShortcutRegistryTest, TheFirstModifiersAreAlwaysReported) {
  ShortcutRegistry registry;
  RecordingChannel channel(registry);

  registry.SetModifiers(
      Modifiers{/*alt=*/false, /*ctrl=*/false, /*shift=*/false, /*meta=*/false});

  EXPECT_EQ(1u, channel.modifiers().size());
}

}  // namespace
}  // namespace domicile
