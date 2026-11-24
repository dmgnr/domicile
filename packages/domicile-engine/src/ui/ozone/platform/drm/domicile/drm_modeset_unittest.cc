// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_modeset.h"

#include <drm_fourcc.h>

#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/types/display_color_management.h"
#include "ui/display/types/display_constants.h"
#include "ui/ozone/platform/drm/domicile/drm_screen.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/ozone/platform/drm/host/drm_window_host_manager.h"
#include "ui/display/types/display_mode.h"
#include "ui/display/types/display_snapshot.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/hdr_static_metadata.h"

namespace ui {
namespace {

// Builds snapshots without the ChromeOS-only `fake_display_snapshot.h`.
// Duplicated in drm_screen_unittest.cc; share it if a third suite needs it.
class SnapshotBuilder {
 public:
  SnapshotBuilder& Id(int64_t id) {
    id_ = id;
    return *this;
  }
  SnapshotBuilder& Origin(const gfx::Point& origin) {
    origin_ = origin;
    return *this;
  }
  SnapshotBuilder& NativeMode(const gfx::Size& size, float refresh_hz) {
    native_mode_size_ = size;
    native_refresh_hz_ = refresh_hz;
    return *this;
  }
  // A connector whose CRTC scans nothing out, such as one a hotplug just
  // moved to an unlit CRTC.
  SnapshotBuilder& Dark() {
    lit_ = false;
    return *this;
  }
  SnapshotBuilder& NoNativeMode() {
    native_mode_size_.reset();
    return *this;
  }
  // Whether the connector can scan out with a variable refresh rate, and
  // does.
  SnapshotBuilder& AdaptiveSync(display::VariableRefreshRateState state) {
    adaptive_sync_ = state;
    return *this;
  }
  // A 10-bit panel on 10-bit planes whose EDID takes PQ and peaks at
  // `peak_nits`.
  SnapshotBuilder& Hdr(double peak_nits) {
    color_info_.bits_per_channel = 10;
    color_info_.hdr_static_metadata = gfx::HDRStaticMetadata(
        peak_nits, peak_nits / 2, 0.05,
        gfx::HDRStaticMetadata::EotfMask(
            {gfx::HDRStaticMetadata::Eotf::kGammaSdrRange,
             gfx::HDRStaticMetadata::Eotf::kPq}));
    formats_ = {{DRM_FORMAT_XRGB8888, {}}, {DRM_FORMAT_XBGR2101010, {}}};
    return *this;
  }
  // Another advertised mode, after the native one.
  SnapshotBuilder& AlsoOffers(const gfx::Size& size,
                              float refresh_hz,
                              bool interlaced = false) {
    others_.push_back({size, refresh_hz, interlaced});
    return *this;
  }

  std::unique_ptr<display::DisplaySnapshot> Build() {
    display::DisplaySnapshot::DisplayModeList modes;
    const display::DisplayMode* native = nullptr;
    if (native_mode_size_.has_value()) {
      modes.push_back(std::make_unique<display::DisplayMode>(
          *native_mode_size_, /*interlaced=*/false, native_refresh_hz_));
      native = modes.back().get();
    }
    for (const Other& other : others_) {
      modes.push_back(std::make_unique<display::DisplayMode>(
          other.size, other.interlaced, other.refresh_hz));
    }
    return std::make_unique<display::DisplaySnapshot>(
        id_, id_, id_, /*connector_index=*/0u, origin_, gfx::Size(520, 320),
        display::DISPLAY_CONNECTION_TYPE_HDMI, /*base_connector_id=*/1u,
        /*path_topology=*/std::vector<uint64_t>(),
        /*is_aspect_preserving_scaling=*/false, /*has_overscan=*/false,
        display::PrivacyScreenState::kNotSupported,
        /*has_content_protection_key=*/false, color_info_, "a panel",
        base::FilePath(),
        std::move(modes), display::PanelOrientation::kNormal,
        /*edid=*/std::vector<uint8_t>(),
        /*current_mode=*/lit_ ? native : nullptr, native, /*product_code=*/0,
        /*year_of_manufacture=*/0, gfx::Size(), adaptive_sync_, formats_);
  }

 private:
  int64_t id_ = 1;
  bool lit_ = true;
  gfx::Point origin_;
  display::VariableRefreshRateState adaptive_sync_ =
      display::VariableRefreshRateState::kVrrNotCapable;
  std::optional<gfx::Size> native_mode_size_ = gfx::Size(1920, 1080);
  float native_refresh_hz_ = 60.f;
  display::DisplaySnapshot::ColorInfo color_info_;
  display::DrmFormatsAndModifiers formats_;
  struct Other {
    gfx::Size size;
    float refresh_hz;
    bool interlaced;
  };
  std::vector<Other> others_;
};

std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> Pointers(
    const std::vector<std::unique_ptr<display::DisplaySnapshot>>& owned) {
  std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> pointers;
  for (const std::unique_ptr<display::DisplaySnapshot>& snapshot : owned) {
    pointers.push_back(snapshot.get());
  }
  return pointers;
}

TEST(DrmModesetTest, AReadingSaysWhatEveryConnectorReported) {
  // The mode must be logged: the browser window has to match it exactly.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder()
                      .Id(7)
                      .Origin(gfx::Point(0, 0))
                      .NativeMode(gfx::Size(2880, 1920), 120.f)
                      .Build());
  owned.push_back(SnapshotBuilder()
                      .Id(9)
                      .Origin(gfx::Point(2880, 0))
                      .NoNativeMode()
                      .Build());

  EXPECT_EQ(DescribeSnapshots(Pointers(owned)),
            "2 connector(s): 7 at 0,0 2880x1920@120; 9 at 2880,0 no mode");
}

TEST(DrmModesetTest, AReadingOfNothingSaysSo) {
  // An empty reading is normal and still gets a log line.
  EXPECT_EQ(DescribeSnapshots({}), "0 connector(s)");
}

TEST(DrmModesetTest, AModesetAsksForTheSnapshotsNativeMode) {
  auto snapshot = SnapshotBuilder()
                      .Id(7)
                      .NativeMode(gfx::Size(2560, 1440), 144.f)
                      .Build();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(std::move(snapshot));

  const auto params = ModesetParamsFromSnapshots(Pointers(owned), {});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_EQ(params[0].id, 7);
  ASSERT_NE(params[0].mode, nullptr);
  EXPECT_EQ(params[0].mode->size(), gfx::Size(2560, 1440));
}

// The snapshot's own origin is (0, 0) for any connector ozone has not read
// before, so identical monitors would overlap. The modeset must use the display
// list's origins, or a window sized to its display matches no CRTC.
TEST(DrmModesetTest, WithNoLayoutTheModesetLightsWhereTheDisplayListSays) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  for (const int64_t id : {11, 12, 13}) {
    owned.push_back(SnapshotBuilder()
                        .Id(id)
                        .Origin(gfx::Point(0, 0))
                        .NativeMode(gfx::Size(3840, 2160), 60.f)
                        .Build());
  }

  const auto params = ModesetParamsFromSnapshots(Pointers(owned), {});
  const std::vector<display::Display> displays =
      DisplaysFromSnapshots(Pointers(owned), {});

  ASSERT_EQ(params.size(), 3u);
  ASSERT_EQ(displays.size(), 3u);
  EXPECT_EQ(params[2].origin, gfx::Point(7680, 0));
  for (size_t i = 0; i < params.size(); ++i) {
    EXPECT_EQ(params[i].origin, displays[i].bounds().origin())
        << "connector " << params[i].id;
  }
}

// `DisplaysFromSnapshots` gives this connector a fallback, since a window needs
// somewhere to land. A modeset must not invent a mode the hardware never
// advertised.
TEST(DrmModesetTest, AConnectorWithNoModeIsNotGivenOne) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(4).NoNativeMode().Build());

  EXPECT_TRUE(ModesetParamsFromSnapshots(Pointers(owned), {}).empty());
}

TEST(DrmModesetTest, AReadableConnectorSurvivesAnUnreadableOneBesideIt) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(4).NoNativeMode().Build());
  owned.push_back(SnapshotBuilder()
                      .Id(5)
                      .NativeMode(gfx::Size(1280, 1024), 60.f)
                      .Build());

  const auto params = ModesetParamsFromSnapshots(Pointers(owned), {});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_EQ(params[0].id, 5);
}

// The layout carries the compositor's display profile. Without it, a
// connector the profile turns off stays lit and monitors are ordered as the
// card enumerates them.
TEST(DrmModesetTest, ALayoutSaysWhereAConnectorGoes) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(
      SnapshotBuilder().Id(3).Origin(gfx::Point(1920, 0)).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 3, .enabled = true, .origin = gfx::Point(0, 0)}});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_EQ(params[0].origin, gfx::Point(0, 0))
      << "the layout's corner, not the one the card happened to stack it at";
}

// A laptop panel offering a smaller size at two rates, and its native size at
// a faster one.
std::unique_ptr<display::DisplaySnapshot> APanelOfManyModes() {
  return SnapshotBuilder()
      .Id(3)
      .NativeMode(gfx::Size(2880, 1920), 60.f)
      .AlsoOffers(gfx::Size(2880, 1920), 120.f)
      .AlsoOffers(gfx::Size(1920, 1280), 60.f)
      .AlsoOffers(gfx::Size(1920, 1280), 119.88f)
      .AlsoOffers(gfx::Size(1920, 1280), 144.f, /*interlaced=*/true)
      .Build();
}

TEST(DrmModesetTest, ALayoutWithNoModeKeepsTheNativeOne) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(APanelOfManyModes());

  const auto params =
      ModesetParamsFromSnapshots(Pointers(owned), {{.id = 3, .enabled = true}});

  ASSERT_EQ(params.size(), 1u);
  ASSERT_NE(params[0].mode, nullptr);
  EXPECT_EQ(params[0].mode->size(), gfx::Size(2880, 1920));
  EXPECT_FLOAT_EQ(params[0].mode->refresh_rate(), 60.f)
      << "the native mode, not the fastest at its size";
}

TEST(DrmModesetTest, AModesetAsksForTheModeTheLayoutNames) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(APanelOfManyModes());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned),
      {{.id = 3, .enabled = true, .mode = gfx::Size(1920, 1280)}});

  ASSERT_EQ(params.size(), 1u);
  ASSERT_NE(params[0].mode, nullptr);
  EXPECT_EQ(params[0].mode->size(), gfx::Size(1920, 1280));
  EXPECT_FLOAT_EQ(params[0].mode->refresh_rate(), 119.88f)
      << "with no rate asked for, the fastest progressive mode at the size";
}

TEST(DrmModesetTest, ARateLandsOnTheNearestOneAdvertised) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(APanelOfManyModes());

  const auto at_the_size = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 3,
                         .enabled = true,
                         .mode = gfx::Size(1920, 1280),
                         .refresh_mhz = 75000}});
  ASSERT_NE(at_the_size[0].mode, nullptr);
  EXPECT_FLOAT_EQ(at_the_size[0].mode->refresh_rate(), 60.f)
      << "75 Hz is nearer 60 than 119.88";

  const auto native_size = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 3, .enabled = true, .refresh_mhz = 120000}});
  ASSERT_NE(native_size[0].mode, nullptr);
  EXPECT_EQ(native_size[0].mode->size(), gfx::Size(2880, 1920))
      << "a rate alone keeps the native size";
  EXPECT_FLOAT_EQ(native_size[0].mode->refresh_rate(), 120.f);
}

TEST(DrmModesetTest, AModeTheConnectorDoesNotAdvertiseIsTheNativeOne) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(APanelOfManyModes());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned),
      {{.id = 3, .enabled = true, .mode = gfx::Size(3840, 2160)}});

  ASSERT_NE(params[0].mode, nullptr);
  EXPECT_EQ(params[0].mode->size(), gfx::Size(2880, 1920))
      << "the compositor sees the size and refuses the profile";
}

TEST(DrmModesetTest, TheDisplayListIsSizedAtTheModeTheModesetAsksFor) {
  // A window binds to its CRTC on an exact rectangle match, so the display
  // and the modeset must agree, and the next connector must start where the
  // smaller mode ends.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(APanelOfManyModes());
  owned.push_back(SnapshotBuilder().Id(5).Build());
  const std::vector<DomicileDisplayLayout> layout = {
      {.id = 3, .enabled = true, .mode = gfx::Size(1920, 1280)}};

  const std::vector<display::Display> displays =
      DisplaysFromSnapshots(Pointers(owned), layout);

  ASSERT_EQ(displays.size(), 2u);
  EXPECT_EQ(displays[0].bounds(), gfx::Rect(0, 0, 1920, 1280));
  EXPECT_FLOAT_EQ(displays[0].display_frequency(), 119.88f);
  EXPECT_EQ(displays[1].bounds().origin(), gfx::Point(1920, 0));
}

TEST(DrmModesetTest, APanelSaysWhatItOffersAndTheRateItIsAt) {
  const std::unique_ptr<display::DisplaySnapshot> panel = APanelOfManyModes();

  const DomicilePanel offered = PanelFromSnapshot(
      *panel, {{.id = 3, .enabled = true, .mode = gfx::Size(1920, 1280)}});

  ASSERT_EQ(offered.modes.size(), 5u);
  EXPECT_EQ(offered.modes[2].size, gfx::Size(1920, 1280));
  EXPECT_EQ(offered.modes[3].refresh_mhz, 119880);
  EXPECT_EQ(offered.refresh_mhz, 119880)
      << "the rate of the mode the modeset asks for, which a listed "
         "display::Display would not update";
  EXPECT_EQ(offered.physical_size_mm, gfx::Size(520, 320));
}

// A panel that can scan out with a variable refresh rate and is not.
std::unique_ptr<display::DisplaySnapshot> AnAdaptivePanel() {
  return SnapshotBuilder()
      .Id(5)
      .NativeMode(gfx::Size(2560, 1440), 144.f)
      .AdaptiveSync(display::VariableRefreshRateState::kVrrDisabled)
      .Build();
}

TEST(DrmModesetTest, AProfileAsksACapablePanelForAdaptiveSync) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(AnAdaptivePanel());

  const auto asked = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 5, .enabled = true, .adaptive_sync = true}});
  const auto unasked =
      ModesetParamsFromSnapshots(Pointers(owned), {{.id = 5, .enabled = true}});

  ASSERT_EQ(asked.size(), 1u);
  EXPECT_TRUE(asked[0].enable_vrr);
  ASSERT_EQ(unasked.size(), 1u);
  EXPECT_FALSE(unasked[0].enable_vrr) << "adaptive sync is off by default";
  EXPECT_FALSE(ModesetParamsFromSnapshots(Pointers(owned), {})[0].enable_vrr)
      << "with no profile, every connector is at the hardware's defaults";
}

TEST(DrmModesetTest, AnIncapablePanelIsNotAskedForAdaptiveSync) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(5).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 5, .enabled = true, .adaptive_sync = true}});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_FALSE(params[0].enable_vrr)
      << "a connector with no vrr_capable must not be asked for it";
  EXPECT_EQ(PanelFromSnapshot(*owned[0], {}).adaptive_sync,
            DomicileAdaptiveSync::kUnsupported);
}

TEST(DrmModesetTest, APanelWhoseAdaptiveSyncWasRefusedIsNotAskedAgain) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(AnAdaptivePanel());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 5, .enabled = true, .adaptive_sync = true}},
      /*refused=*/{5});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_FALSE(params[0].enable_vrr);
  ASSERT_NE(params[0].mode, nullptr) << "it still lights";
}

TEST(DrmModesetTest, APanelSaysWhetherItsAdaptiveSyncIsOn) {
  const std::unique_ptr<display::DisplaySnapshot> off = AnAdaptivePanel();
  const std::unique_ptr<display::DisplaySnapshot> on =
      SnapshotBuilder()
          .Id(5)
          .AdaptiveSync(display::VariableRefreshRateState::kVrrEnabled)
          .Build();

  EXPECT_EQ(PanelFromSnapshot(*off, {}).adaptive_sync,
            DomicileAdaptiveSync::kOff);
  EXPECT_EQ(PanelFromSnapshot(*on, {}).adaptive_sync,
            DomicileAdaptiveSync::kOn);
}

// display::DisplayList compares neither, so DrmScreen tells its observers.
TEST(DrmModesetTest, ARateOrAdaptiveSyncChangingIsWorthTellingTheList) {
  const DomicilePanel off = PanelFromSnapshot(*AnAdaptivePanel(), {});
  DomicilePanel on = off;
  on.adaptive_sync = DomicileAdaptiveSync::kOn;
  DomicilePanel faster = off;
  faster.refresh_mhz = 165000;

  EXPECT_FALSE(PanelChangedUnseen(off, off));
  EXPECT_TRUE(PanelChangedUnseen(off, on));
  EXPECT_TRUE(PanelChangedUnseen(off, faster));
}

// A 10-bit panel whose EDID takes PQ and peaks at 600 cd/m².
std::unique_ptr<display::DisplaySnapshot> AnHdrPanel() {
  return SnapshotBuilder().Id(5).Hdr(600).Build();
}

TEST(DrmModesetTest, AProfileAsksAnHdrPanelForHdr) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(AnHdrPanel());

  const auto asked = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 5, .enabled = true, .hdr = true}});
  const auto unasked =
      ModesetParamsFromSnapshots(Pointers(owned), {{.id = 5, .enabled = true}});

  ASSERT_EQ(asked.size(), 1u);
  EXPECT_TRUE(asked[0].domicile_hdr);
  ASSERT_EQ(unasked.size(), 1u);
  EXPECT_FALSE(unasked[0].domicile_hdr) << "HDR is off by default";
  EXPECT_FALSE(ModesetParamsFromSnapshots(Pointers(owned), {})[0].domicile_hdr);
}

TEST(DrmModesetTest, APanelWithoutPqIsNotAskedForHdr) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(5).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 5, .enabled = true, .hdr = true}});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_FALSE(params[0].domicile_hdr);
  EXPECT_EQ(PanelFromSnapshot(*owned[0], {{.id = 5, .hdr = true}}).hdr,
            DomicileHdr::kUnsupported);
}

TEST(DrmModesetTest, APanelSaysWhetherItIsInHdrAndHowBrightItGets) {
  const std::unique_ptr<display::DisplaySnapshot> panel = AnHdrPanel();

  const DomicilePanel off = PanelFromSnapshot(*panel, {});
  const DomicilePanel on = PanelFromSnapshot(
      *panel,
      {{.id = 5, .enabled = true, .hdr = true, .sdr_white_nits = 250.f}});

  EXPECT_EQ(off.hdr, DomicileHdr::kOff);
  EXPECT_FLOAT_EQ(off.max_luminance, 600.f);
  EXPECT_FLOAT_EQ(off.max_average_luminance, 300.f);
  EXPECT_FLOAT_EQ(off.min_luminance, 0.05f);
  EXPECT_EQ(on.hdr, DomicileHdr::kOn);
  EXPECT_FLOAT_EQ(on.sdr_white_nits, 250.f);
  EXPECT_TRUE(PanelChangedUnseen(off, on))
      << "display::DisplayList compares no HDR state";
}

TEST(DrmModesetTest, ALayoutCanLeaveAConnectorDark) {
  // For example, a laptop panel behind a closed lid.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(1).Build());
  owned.push_back(SnapshotBuilder().Id(2).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 1, .enabled = false, .origin = gfx::Point()},
                        {.id = 2, .enabled = true, .origin = gfx::Point()}});

  ASSERT_EQ(params.size(), 2u);
  EXPECT_EQ(params[0].id, 1);
  EXPECT_EQ(params[0].mode, nullptr)
      << "a connector left out of the modeset keeps scanning out its last "
         "frame, so it must be asked for with no mode to turn it off";
  EXPECT_EQ(params[1].id, 2);
  EXPECT_NE(params[1].mode, nullptr);
}

TEST(DrmModesetTest, ABlankTurnsEveryConnectorOff) {
  // An idle blank lists every connector with `enabled: false`.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(1).Build());
  owned.push_back(SnapshotBuilder().Id(2).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 1, .enabled = false, .origin = gfx::Point()},
                        {.id = 2, .enabled = false, .origin = gfx::Point()}});

  ASSERT_EQ(params.size(), 2u)
      << "an empty request is no modeset at all, and the screens stay lit";
  EXPECT_EQ(params[0].mode, nullptr);
  EXPECT_EQ(params[1].mode, nullptr);
}

TEST(DrmModesetTest, AConnectorNoLayoutNamesIsLeftDark) {
  // A monitor plugged in after the compositor's last answer. It lights once
  // the compositor answers the hotplug this modeset triggers.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(1).Build());
  owned.push_back(SnapshotBuilder().Id(8).Build());

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned), {{.id = 1, .enabled = true, .origin = gfx::Point()}});

  ASSERT_EQ(params.size(), 2u);
  EXPECT_EQ(params[0].id, 1);
  EXPECT_NE(params[0].mode, nullptr);
  EXPECT_EQ(params[1].id, 8);
  EXPECT_EQ(params[1].mode, nullptr);
}

TEST(DrmModesetTest, ALayoutStillDoesNotInventAModeForAConnectorWithNone) {
  // The layout places a connector; it does not supply a mode.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(4).NoNativeMode().Build());

  EXPECT_TRUE(ModesetParamsFromSnapshots(
                  Pointers(owned),
                  {{.id = 4, .enabled = true, .origin = gfx::Point(0, 0)}})
                  .empty());
}

TEST(DrmModesetTest, NothingPluggedInAsksForNoModeset) {
  EXPECT_TRUE(ModesetParamsFromSnapshots({}, {}).empty());
}

TEST(DrmModesetTest, EveryReadableConnectorIsAskedFor) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(1).Build());
  owned.push_back(SnapshotBuilder().Id(2).Origin(gfx::Point(1920, 0)).Build());

  const auto params = ModesetParamsFromSnapshots(Pointers(owned), {});

  ASSERT_EQ(params.size(), 2u);
  EXPECT_EQ(params[0].id, 1);
  EXPECT_EQ(params[1].id, 2);
}

// Each `Configure` makes the kernel emit a udev CHANGE, which triggers another
// reading. Repeating an unchanged modeset would loop and the screen would never
// settle.
TEST(DrmModesetTest, TheSameReadingTwiceIsNotWorthAModeset) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  const std::vector<display::DisplayConfigurationParams> once =
      ModesetParamsFromSnapshots(Pointers(snapshots), {});
  const std::vector<display::DisplayConfigurationParams> again =
      ModesetParamsFromSnapshots(Pointers(snapshots), {});

  EXPECT_TRUE(ModesetParamsThatChange(once, again, Pointers(snapshots)).empty())
      << "asking the hardware for the mode it just reported is the loop";
}

TEST(DrmModesetTest, TheFirstReadingIsAlwaysWorthAModeset) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());

  EXPECT_EQ(ModesetParamsThatChange(
                {}, ModesetParamsFromSnapshots(Pointers(snapshots), {}),
                Pointers(snapshots))
                .size(),
            1u)
      << "nothing has been asked for yet, so everything is a change";
}

// A real hotplug changes the reading and must always modeset.
TEST(DrmModesetTest, ADisplayArrivingIsWorthAModeset) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> one;
  one.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  std::vector<std::unique_ptr<display::DisplaySnapshot>> two;
  two.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  two.push_back(SnapshotBuilder()
                    .Id(12)
                    .Origin(gfx::Point(2880, 0))
                    .NativeMode(gfx::Size(3840, 2160), 60.f)
                    .Build());

  const std::vector<display::DisplayConfigurationParams> changed =
      ModesetParamsThatChange(ModesetParamsFromSnapshots(Pointers(one), {}),
                              ModesetParamsFromSnapshots(Pointers(two), {}),
                              Pointers(two));

  ASSERT_EQ(changed.size(), 1u);
  EXPECT_EQ(changed[0].id, 12)
      << "the display already lit is left alone, so it does not flash";
}

TEST(DrmModesetTest, AModeChangingOnOneDisplayIsWorthAModeset) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> before;
  before.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  std::vector<std::unique_ptr<display::DisplaySnapshot>> after;
  after.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(1920, 1080), 60.f).Build());

  EXPECT_EQ(
      ModesetParamsThatChange(ModesetParamsFromSnapshots(Pointers(before), {}),
                              ModesetParamsFromSnapshots(Pointers(after), {}),
                              Pointers(after))
          .size(),
      1u)
      << "the same connector at a different mode is a different request";
}

// A delegate that records each `Configure` and answers when the test says so.
class FakeDelegate : public display::NativeDisplayDelegate {
 public:
  // display::NativeDisplayDelegate, the parts these tests drive:
  void GetDisplays(display::GetDisplaysCallback callback) override {
    ++readings_asked_;
    if (defers_readings_) {
      readings_.push_back(std::move(callback));
      return;
    }
    std::move(callback).Run(snapshots_);
  }
  void Configure(
      const std::vector<display::DisplayConfigurationParams>& config_requests,
      display::ConfigureCallback callback,
      display::ModesetFlags modeset_flags) override {
    asked_.push_back(config_requests);
    if (inline_answer_.has_value()) {
      std::move(callback).Run(config_requests, *inline_answer_);
      return;
    }
    pending_ = std::move(callback);
  }

  // Answers the pending `Configure` as the DRM thread would.
  void Answer(bool status) {
    ASSERT_TRUE(pending_) << "nothing was asked, so there is nothing to answer";
    std::move(pending_).Run({}, status);
  }
  // Answers from inside `Configure`, as
  // `DrmDisplayHostManager::ConfigureDisplays` does for dummy displays.
  void AnswersFromInsideConfigure(bool status) { inline_answer_ = status; }
  // Drops the pending `Configure`, as when the GPU process has no DRM device
  // yet.
  void NeverAnswers() { pending_.Reset(); }

  // Holds each `GetDisplays` until `AnswerReading`, as the GPU process does
  // while it reads the connectors.
  void DefersReadings() { defers_readings_ = true; }
  // Answers the oldest held `GetDisplays` with the current snapshots.
  void AnswerReading() {
    ASSERT_FALSE(readings_.empty()) << "no reading was asked for";
    display::GetDisplaysCallback callback = std::move(readings_.front());
    readings_.erase(readings_.begin());
    std::move(callback).Run(snapshots_);
  }
  size_t readings_asked() const { return readings_asked_; }
  size_t readings_held() const { return readings_.size(); }

  bool was_asked() const { return !pending_.is_null(); }
  size_t asks() const { return asked_.size(); }
  // Each `SetGammaAdjustment`, as the display it named and its curve.
  const std::vector<std::pair<int64_t, display::GammaCurve>>& gamma() const {
    return gamma_;
  }
  const std::vector<display::DisplayConfigurationParams>& last_ask() const {
    return asked_.back();
  }

  void SetSnapshots(
      std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> s) {
    snapshots_ = std::move(s);
  }

  // Unused by these tests.
  void Initialize() override {}
  void TakeDisplayControl(display::DisplayControlCallback callback) override {
    std::move(callback).Run(true);
  }
  void RelinquishDisplayControl(
      display::DisplayControlCallback callback) override {
    std::move(callback).Run(true);
  }
  void SetHdcpKeyProp(int64_t,
                      const std::string&,
                      display::SetHdcpKeyPropCallback callback) override {
    std::move(callback).Run(false);
  }
  void GetHDCPState(const display::DisplaySnapshot&,
                    display::GetHDCPStateCallback callback) override {
    std::move(callback).Run(false, display::HDCPState::HDCP_STATE_UNDESIRED,
                            display::CONTENT_PROTECTION_METHOD_NONE);
  }
  void SetHDCPState(const display::DisplaySnapshot&,
                    display::HDCPState,
                    display::ContentProtectionMethod,
                    display::SetHDCPStateCallback callback) override {
    std::move(callback).Run(false);
  }
  void SetColorTemperatureAdjustment(
      int64_t,
      const display::ColorTemperatureAdjustment&) override {}
  void SetColorCalibration(int64_t,
                           const display::ColorCalibration&) override {}
  void SetGammaAdjustment(int64_t display_id,
                          const display::GammaAdjustment& adjustment) override {
    gamma_.emplace_back(display_id, adjustment.curve);
  }
  void SetPrivacyScreen(int64_t,
                        bool,
                        display::SetPrivacyScreenCallback callback) override {
    std::move(callback).Run(false);
  }
  void GetSeamlessRefreshRates(
      int64_t,
      display::GetSeamlessRefreshRatesCallback callback) const override {
    std::move(callback).Run(std::nullopt);
  }
  void AddObserver(display::NativeDisplayObserver*) override {}
  void RemoveObserver(display::NativeDisplayObserver*) override {}
  display::FakeDisplayController* GetFakeDisplayController() override {
    return nullptr;
  }

 private:
  std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> snapshots_;
  std::vector<std::vector<display::DisplayConfigurationParams>> asked_;
  display::ConfigureCallback pending_;
  std::optional<bool> inline_answer_;
  std::vector<std::pair<int64_t, display::GammaCurve>> gamma_;
  bool defers_readings_ = false;
  std::vector<display::GetDisplaysCallback> readings_;
  size_t readings_asked_ = 0;
};

// The first `Configure` goes out before the GPU process has a DRM device, so
// it never answers. The udev ADD that follows carries the same reading and must
// still modeset.
TEST(DrmModesetTest, AnAskThatReachedNothingDoesNotSuppressTheNextOne) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  ASSERT_EQ(fake->asks(), 1u) << "the first reading must be asked for";
  fake->NeverAnswers();  // The GPU process has no DRM device yet.

  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->asks(), 2u)
      << "an ask nothing confirmed must not suppress the ask that follows it";
}

// After a confirmed modeset, the hotplug it causes must not modeset again.
TEST(DrmModesetTest, AConfirmedModesetSuppressesTheHotplugItCauses) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  ASSERT_EQ(fake->asks(), 1u);
  fake->Answer(true);

  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->asks(), 1u)
      << "the CHANGE a successful Configure emits is this driver's own echo";
}

// After a refused modeset the hardware state is unknown, so the next reading
// must modeset.
TEST(DrmModesetTest, ARefusedModesetDoesNotSuppressTheNextOne) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  fake->Answer(false);

  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->asks(), 2u);
}

// `Start()` runs before the GPU process exists, so `DrmDisplayHostManager`
// answers from its dummy snapshots without reaching hardware. Recording that
// answer would suppress a matching first real reading, and a machine whose
// dummy reading matches its real one would never modeset.
TEST(DrmModesetTest, AnAnswerFromInsideTheAskIsNotAConfirmation) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));
  fake->AnswersFromInsideConfigure(true);

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  ASSERT_EQ(fake->asks(), 1u) << "the first reading must be asked for";

  // The GPU process is up and reports the same displays as the dummies.
  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->asks(), 2u)
      << "a yes that arrived before the ask returned reached no hardware, so "
         "the first real reading must still get through";
}


// After a resume the GPU state is lost but the connectors report the same as
// before, so the loop guard alone would leave every panel dark.
TEST(DrmModesetTest, AWakeLightsTheScreensAgainThoughTheyReadTheSame) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  ASSERT_EQ(fake->asks(), 1u);
  fake->Answer(true);

  modeset.Relight();
  EXPECT_EQ(fake->asks(), 2u)
      << "a GPU that came back with its CRTCs reset reports what it reported "
         "before, so the reading cannot be what decides";
}

// `Relight` clears one confirmation, not the guard: the hotplug its own
// modeset causes is still suppressed.
TEST(DrmModesetTest, ARelitScreenStillSuppressesTheHotplugItCauses) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  fake->Answer(true);
  modeset.Relight();
  ASSERT_EQ(fake->asks(), 2u);
  fake->Answer(true);

  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->asks(), 2u)
      << "the CHANGE the relight's own Configure emits is still this driver's "
         "own echo";
}

// A display asked for again can flash, so sleeping or waking one monitor asks
// for that monitor alone.
TEST(DrmModesetTest, AModesetAsksOnlyForTheDisplaysThatChanged) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(1).Build());
  snapshots.push_back(SnapshotBuilder().Id(2).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.SetLayout(
      {{.id = 1, .enabled = true, .origin = gfx::Point()},
       {.id = 2, .enabled = true, .origin = gfx::Point(1920, 0)}});
  ASSERT_EQ(fake->last_ask().size(), 2u);
  fake->Answer(true);

  modeset.SetLayout(
      {{.id = 1, .enabled = false, .origin = gfx::Point()},
       {.id = 2, .enabled = true, .origin = gfx::Point(1920, 0)}});
  ASSERT_EQ(fake->asks(), 2u);
  ASSERT_EQ(fake->last_ask().size(), 1u);
  EXPECT_EQ(fake->last_ask()[0].id, 1);
  EXPECT_EQ(fake->last_ask()[0].mode, nullptr);
  fake->Answer(true);

  modeset.SetLayout(
      {{.id = 1, .enabled = true, .origin = gfx::Point()},
       {.id = 2, .enabled = true, .origin = gfx::Point(1920, 0)}});
  ASSERT_EQ(fake->asks(), 3u);
  ASSERT_EQ(fake->last_ask().size(), 1u);
  EXPECT_EQ(fake->last_ask()[0].id, 1);
  EXPECT_NE(fake->last_ask()[0].mode, nullptr);
}

TEST(DrmModesetTest, AnUnchangedDisplayThatReadsDarkIsAskedForAgain) {
  // A hotplug can move a display to another CRTC, which nothing has lit.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> lit;
  lit.push_back(SnapshotBuilder().Id(1).Build());
  std::vector<std::unique_ptr<display::DisplaySnapshot>> dark;
  dark.push_back(SnapshotBuilder().Id(1).Dark().Build());

  EXPECT_EQ(
      ModesetParamsThatChange(ModesetParamsFromSnapshots(Pointers(lit), {}),
                              ModesetParamsFromSnapshots(Pointers(dark), {}),
                              Pointers(dark))
          .size(),
      1u);
}

TEST(DrmModesetTest, AMonitorPluggedBackInIsLitAgain) {
  // An unplug asks for nothing, and must not leave the monitor recorded as
  // lit for when it comes back.
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> both;
  both.push_back(SnapshotBuilder().Id(1).Build());
  both.push_back(SnapshotBuilder().Id(2).Origin(gfx::Point(1920, 0)).Build());
  std::vector<std::unique_ptr<display::DisplaySnapshot>> one;
  one.push_back(SnapshotBuilder().Id(1).Build());
  fake->SetSnapshots(Pointers(both));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.Start();
  fake->Answer(true);
  fake->SetSnapshots(Pointers(one));
  modeset.OnConfigurationChanged();
  ASSERT_EQ(fake->asks(), 1u) << "the display still plugged in is unchanged";

  fake->SetSnapshots(Pointers(both));
  modeset.OnConfigurationChanged();
  ASSERT_EQ(fake->asks(), 2u);
  ASSERT_EQ(fake->last_ask().size(), 1u);
  EXPECT_EQ(fake->last_ask()[0].id, 2);
}

// A virtual display's id has the top bit set, as the compositor picks it.
constexpr int64_t kVirtualId = std::numeric_limits<int64_t>::min() | 1;

TEST(DrmModesetTest, AVirtualDisplayIsANetworkDisplayAtItsMode) {
  const std::unique_ptr<display::DisplaySnapshot> snapshot =
      VirtualSnapshot({.id = kVirtualId,
                       .mode = gfx::Size(1920, 1080),
                       .refresh_mhz = 60000,
                       .name = "Living Room TV"});

  EXPECT_EQ(snapshot->display_id(), kVirtualId);
  EXPECT_EQ(snapshot->type(), display::DISPLAY_CONNECTION_TYPE_NETWORK);
  ASSERT_NE(snapshot->native_mode(), nullptr);
  EXPECT_EQ(snapshot->native_mode()->size(), gfx::Size(1920, 1080));
  EXPECT_EQ(snapshot->native_mode()->refresh_rate(), 60.f);
  EXPECT_EQ(snapshot->current_mode(), snapshot->native_mode());
  EXPECT_EQ(DisplayNameFromSnapshot(*snapshot), "Living Room TV");
  EXPECT_EQ(snapshot->domicile_connector(), "virtual-1");
}

// No CRTC drives a virtual display, so asking for one would fail the whole
// modeset.
TEST(DrmModesetTest, AVirtualDisplayLightsNoCrtc) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> owned;
  owned.push_back(SnapshotBuilder().Id(1).Build());
  owned.push_back(VirtualSnapshot({.id = kVirtualId,
                                   .mode = gfx::Size(1920, 1080),
                                   .refresh_mhz = 60000,
                                   .name = "TV"}));

  const auto params = ModesetParamsFromSnapshots(
      Pointers(owned),
      {{.id = 1, .enabled = true, .origin = gfx::Point(0, 0)},
       {.id = kVirtualId, .enabled = true, .origin = gfx::Point(1920, 0)}});

  ASSERT_EQ(params.size(), 1u);
  EXPECT_EQ(params[0].id, 1);
}

// The desk extends onto it, so the screen lists it beside the connectors.
TEST(DrmModesetTest, VirtualDisplaysJoinEveryReading) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(2880, 1920), 120.f).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  fake->Answer(true);

  modeset.SetVirtualDisplays({{.id = kVirtualId,
                               .mode = gfx::Size(1920, 1080),
                               .refresh_mhz = 60000,
                               .name = "TV"}});

  ASSERT_EQ(screen.GetAllDisplays().size(), 2u);
  EXPECT_EQ(screen.GetAllDisplays()[1].id(), kVirtualId);
  EXPECT_EQ(screen.GetAllDisplays()[1].bounds(),
            gfx::Rect(2880, 0, 1920, 1080))
      << "placed past the connectors, as an unnamed connector is";
  EXPECT_EQ(screen.connectors().at(kVirtualId), "virtual-1");
  EXPECT_EQ(fake->asks(), 1u)
      << "the connectors read the same, so nothing is modeset again";

  modeset.SetVirtualDisplays({});

  EXPECT_EQ(screen.GetAllDisplays().size(), 1u);
}

// White as the curve draws it, per channel, out of 65535.
std::vector<uint16_t> WhiteOf(const display::GammaCurve& curve) {
  const display::GammaRampRGBEntry& white = curve.lut().back();
  return {white.r, white.g, white.b};
}

// A two-entry ramp that draws white as (65535, 32768, 16384): a warm one.
DomicileGammaRamp WarmRamp() {
  return {.red = {0, 65535}, .green = {0, 32768}, .blue = {0, 16384}};
}

// Each display draws with its own ramp, so one warms and its neighbor does
// not.
TEST(DrmModesetTest, AGammaRampReachesOnlyItsDisplay) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();

  modeset.SetGamma(12, WarmRamp());

  ASSERT_EQ(fake->gamma().size(), 1u);
  EXPECT_EQ(fake->gamma()[0].first, 12);
  EXPECT_EQ(WhiteOf(fake->gamma()[0].second),
            (std::vector<uint16_t>{65535, 32768, 16384}));
}

// An empty ramp writes an identity ramp: an empty curve left the last warm
// ramp on the CRTCs.
TEST(DrmModesetTest, AnEmptyRampWritesAnIdentityRamp) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();

  modeset.SetGamma(11, {});

  ASSERT_EQ(fake->gamma().size(), 1u);
  EXPECT_FALSE(fake->gamma()[0].second.IsDefaultIdentity());
  EXPECT_EQ(WhiteOf(fake->gamma()[0].second),
            (std::vector<uint16_t>{65535, 65535, 65535}));
}

// A resume or a console switch back can leave the CRTCs at another process's
// ramp, so each confirmed modeset sets every display's ramp again.
TEST(DrmModesetTest, AConfirmedModesetSetsEachDisplaysRampAgain) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  modeset.SetGamma(11, WarmRamp());
  modeset.SetGamma(12, {});
  ASSERT_EQ(fake->gamma().size(), 2u);

  fake->Answer(true);

  ASSERT_EQ(fake->gamma().size(), 4u);
  EXPECT_EQ(fake->gamma()[2].first, 11);
  EXPECT_EQ(WhiteOf(fake->gamma()[2].second),
            (std::vector<uint16_t>{65535, 32768, 16384}));
  EXPECT_EQ(fake->gamma()[3].first, 12);
  EXPECT_EQ(WhiteOf(fake->gamma()[3].second),
            (std::vector<uint16_t>{65535, 65535, 65535}));
}

// The browser's display hosts go with their snapshots, and a ramp for one
// that is gone would reach nothing. The next reading names the displays.
TEST(DrmModesetTest, AGammaRampWaitsForTheReadingAfterAnInvalidation) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  fake->Answer(true);

  modeset.OnDisplaySnapshotsInvalidated();
  modeset.SetGamma(11, WarmRamp());
  EXPECT_TRUE(fake->gamma().empty());
}

// No CRTC drives a virtual display, so it has no ramp to set.
TEST(DrmModesetTest, AGammaRampForAVirtualDisplayReachesNothing) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  fake->Answer(true);
  modeset.SetVirtualDisplays({{.id = kVirtualId,
                               .mode = gfx::Size(1920, 1080),
                               .refresh_mhz = 60000,
                               .name = "TV"}});

  modeset.SetGamma(kVirtualId, WarmRamp());

  EXPECT_TRUE(fake->gamma().empty());
}

// sway's fallback: a driver that refuses a modeset with adaptive sync gets
// the same one without it, and the panel reports it off.
TEST(DrmModesetTest, ARefusedModesetWithAdaptiveSyncIsAskedAgainWithout) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(AnAdaptivePanel());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.SetLayout({{.id = 5, .enabled = true, .adaptive_sync = true}});
  ASSERT_EQ(fake->asks(), 1u);
  ASSERT_TRUE(fake->last_ask()[0].enable_vrr);
  fake->Answer(false);

  ASSERT_EQ(fake->asks(), 2u) << "a refusal with adaptive sync is retried";
  EXPECT_FALSE(fake->last_ask()[0].enable_vrr);
  ASSERT_NE(fake->last_ask()[0].mode, nullptr) << "the retry still lights it";
  fake->Answer(true);
  EXPECT_EQ(screen.panels().at(5).adaptive_sync, DomicileAdaptiveSync::kOff);

  modeset.SetLayout({{.id = 5, .enabled = true, .adaptive_sync = true}});
  EXPECT_EQ(fake->asks(), 2u)
      << "a panel that refused it is not asked again while plugged in";
}

// A refusal of a modeset that asked for no adaptive sync is not about it.
TEST(DrmModesetTest, ARefusedModesetWithoutAdaptiveSyncIsNotRetried) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(AnAdaptivePanel());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.SetLayout({{.id = 5, .enabled = true}});
  fake->Answer(false);
  EXPECT_EQ(fake->asks(), 1u);
}

// A panel asked for again only because it reads dark, as one another session
// left dark does, did not bring adaptive sync into the modeset.
TEST(DrmModesetTest, APanelAskedForOnlyBecauseItReadsDarkKeepsAdaptiveSync) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> lit;
  lit.push_back(AnAdaptivePanel());
  std::vector<std::unique_ptr<display::DisplaySnapshot>> dark;
  dark.push_back(SnapshotBuilder()
                     .Id(5)
                     .NativeMode(gfx::Size(2560, 1440), 144.f)
                     .AdaptiveSync(
                         display::VariableRefreshRateState::kVrrDisabled)
                     .Dark()
                     .Build());
  fake->SetSnapshots(Pointers(lit));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.SetLayout({{.id = 5, .enabled = true, .adaptive_sync = true}});
  fake->Answer(true);
  fake->SetSnapshots(Pointers(dark));
  modeset.OnConfigurationChanged();
  ASSERT_EQ(fake->asks(), 2u);
  fake->Answer(false);

  EXPECT_EQ(fake->asks(), 2u) << "not retried without adaptive sync";
  modeset.OnConfigurationChanged();
  ASSERT_EQ(fake->asks(), 3u);
  EXPECT_TRUE(fake->last_ask()[0].enable_vrr);
}

// A snapshot reads adaptive sync off the CRTC, so the reading a modeset went
// out with predates it. The display list must not keep saying it is off.
TEST(DrmModesetTest, AModesetTurningOnAdaptiveSyncReadsTheDisplaysAgain) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(AnAdaptivePanel());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);

  modeset.SetLayout({{.id = 5, .enabled = true, .adaptive_sync = true}});
  ASSERT_EQ(screen.panels().at(5).adaptive_sync, DomicileAdaptiveSync::kOff);
  // The CRTC now has VRR_ENABLED set.
  snapshots[0]->set_variable_refresh_rate_state(
      display::VariableRefreshRateState::kVrrEnabled);
  fake->Answer(true);

  EXPECT_EQ(screen.panels().at(5).adaptive_sync, DomicileAdaptiveSync::kOn);
  EXPECT_EQ(fake->asks(), 1u)
      << "the reading after asks for the modeset already confirmed";
}

// A hotplug while a reading is in flight waits for it, so the two answers
// cannot interleave, and the displays they name can take a ramp.
TEST(DrmModesetTest, OverlappingReadingsLeaveEveryDisplayRampable) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  fake->DefersReadings();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  modeset.OnConfigurationChanged();
  EXPECT_EQ(fake->readings_held(), 1u);

  fake->AnswerReading();
  ASSERT_EQ(fake->readings_held(), 1u);
  fake->AnswerReading();
  EXPECT_EQ(fake->readings_asked(), 2u);

  modeset.SetGamma(11, WarmRamp());
  modeset.SetGamma(12, WarmRamp());
  ASSERT_EQ(fake->gamma().size(), 2u);
  EXPECT_EQ(fake->gamma()[0].first, 11);
  EXPECT_EQ(fake->gamma()[1].first, 12);
}

// A ramp sent while the displays were unread reaches them on the next
// reading, even one that reads the same and so modesets nothing.
TEST(DrmModesetTest, AReadingThatChangesNothingAppliesTheStoredRamps) {
  auto owned = std::make_unique<FakeDelegate>();
  FakeDelegate* fake = owned.get();
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  fake->SetSnapshots(Pointers(snapshots));

  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  DrmModeset modeset(std::move(owned), &screen);
  modeset.Start();
  fake->Answer(true);
  modeset.OnDisplaySnapshotsInvalidated();
  modeset.SetGamma(11, WarmRamp());
  ASSERT_TRUE(fake->gamma().empty());

  modeset.OnConfigurationChanged();

  EXPECT_FALSE(fake->was_asked());
  ASSERT_EQ(fake->gamma().size(), 1u);
  EXPECT_EQ(fake->gamma()[0].first, 11);
  EXPECT_EQ(WhiteOf(fake->gamma()[0].second),
            (std::vector<uint16_t>{65535, 32768, 16384}));
}

}  // namespace
}  // namespace ui
