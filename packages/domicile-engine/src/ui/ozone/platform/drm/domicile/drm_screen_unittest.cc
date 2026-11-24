// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_screen.h"

#include <drm_fourcc.h>

#include <memory>
#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/memory/raw_ptr.h"
#include "components/viz/common/resources/shared_image_format.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/display_observer.h"
#include "ui/display/types/display_mode.h"
#include "ui/display/types/display_snapshot.h"
#include "ui/gfx/display_color_spaces.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/hdr_static_metadata.h"
#include "ui/ozone/platform/drm/domicile/hdr_output.h"
#include "ui/ozone/platform/drm/host/drm_window_host_manager.h"

namespace ui {
namespace {

// Builds snapshots. `fake_display_snapshot.h` would do this, but
// `//ui/display:test_support` builds it only on ChromeOS.
class SnapshotBuilder {
 public:
  SnapshotBuilder() = default;

  SnapshotBuilder& Id(int64_t id) {
    id_ = id;
    return *this;
  }
  SnapshotBuilder& Origin(const gfx::Point& origin) {
    origin_ = origin;
    return *this;
  }
  // The physical size, in millimeters.
  SnapshotBuilder& PhysicalSizeMm(const gfx::Size& mm) {
    physical_size_mm_ = mm;
    return *this;
  }
  SnapshotBuilder& Name(std::string name) {
    name_ = std::move(name);
    return *this;
  }
  // The packed manufacturer and product ids; the make comes from these.
  SnapshotBuilder& ProductCode(int64_t product_code) {
    product_code_ = product_code;
    return *this;
  }
  // The raw EDID. Only it holds the serial: `display::EdidParser` keeps just
  // a hash.
  SnapshotBuilder& Edid(std::vector<uint8_t> edid) {
    edid_ = std::move(edid);
    return *this;
  }
  SnapshotBuilder& NativeMode(const gfx::Size& size, float refresh_hz) {
    native_mode_size_ = size;
    native_refresh_hz_ = refresh_hz;
    return *this;
  }
  // Models a connected connector whose modes could not be read.
  SnapshotBuilder& NoNativeMode() {
    native_mode_size_.reset();
    return *this;
  }
  // The kernel's name for the connector, as the GPU process sets it.
  SnapshotBuilder& Connector(std::string connector) {
    connector_ = std::move(connector);
    return *this;
  }
  // How many entries the CRTC's gamma ramp has, as the GPU process sets it.
  SnapshotBuilder& GammaSize(uint32_t size) {
    gamma_size_ = size;
    return *this;
  }

  // The bits a channel the EDID reports.
  SnapshotBuilder& BitsPerChannel(uint32_t bits) {
    bits_per_channel_ = bits;
    return *this;
  }

  // The HDR static metadata block of the EDID.
  SnapshotBuilder& HdrMetadata(const gfx::HDRStaticMetadata& metadata) {
    hdr_metadata_ = metadata;
    return *this;
  }

  // The formats the device's planes scan out.
  SnapshotBuilder& PlaneFormats(const std::vector<uint32_t>& formats) {
    plane_formats_.clear();
    for (const uint32_t format : formats) {
      plane_formats_.emplace(format, std::vector<uint64_t>());
    }
    return *this;
  }

  std::unique_ptr<display::DisplaySnapshot> Build() {
    display::DisplaySnapshot::DisplayModeList modes;
    const display::DisplayMode* native = nullptr;
    display::DisplaySnapshot::ColorInfo color_info;
    color_info.bits_per_channel = bits_per_channel_;
    color_info.hdr_static_metadata = hdr_metadata_;
    if (native_mode_size_.has_value()) {
      modes.push_back(std::make_unique<display::DisplayMode>(
          *native_mode_size_, /*interlaced=*/false, native_refresh_hz_));
      native = modes.back().get();
    }
    auto snapshot = std::make_unique<display::DisplaySnapshot>(
        id_, id_, id_, /*connector_index=*/0u, origin_, physical_size_mm_,
        display::DISPLAY_CONNECTION_TYPE_HDMI, /*base_connector_id=*/1u,
        /*path_topology=*/std::vector<uint64_t>(),
        /*is_aspect_preserving_scaling=*/false, /*has_overscan=*/false,
        display::PrivacyScreenState::kNotSupported,
        /*has_content_protection_key=*/false, color_info,
        name_, base::FilePath(), std::move(modes),
        display::PanelOrientation::kNormal, edid_,
        /*current_mode=*/native, native, product_code_,
        /*year_of_manufacture=*/0, gfx::Size(),
        display::VariableRefreshRateState::kVrrNotCapable, plane_formats_);
    snapshot->set_domicile_connector(connector_);
    snapshot->set_domicile_gamma_size(gamma_size_);
    return snapshot;
  }

 private:
  int64_t id_ = 1;
  gfx::Point origin_;
  gfx::Size physical_size_mm_{520, 320};
  std::string name_ = "a panel";
  std::optional<gfx::Size> native_mode_size_ = gfx::Size(1920, 1080);
  float native_refresh_hz_ = 60.f;
  int64_t product_code_ = display::DisplaySnapshot::kInvalidProductCode;
  std::vector<uint8_t> edid_;
  std::string connector_ = "DP-1";
  uint32_t gamma_size_ = 0;
  uint32_t bits_per_channel_ = 8;
  std::optional<gfx::HDRStaticMetadata> hdr_metadata_;
  display::DrmFormatsAndModifiers plane_formats_;
};

// Returns an EDID with `serial` in its first display descriptor.
// edid_name_unittest.cc tests the descriptor parsing itself.
std::vector<uint8_t> EdidWithSerial(const std::string& serial) {
  std::vector<uint8_t> edid(128, 0);
  constexpr size_t kFirstDescriptor = 0x36;
  edid[kFirstDescriptor + 3] = 0xFF;
  for (size_t i = 0; i < 13; ++i) {
    edid[kFirstDescriptor + 5 + i] =
        i < serial.size() ? static_cast<uint8_t>(serial[i]) : 0x20;
  }
  return edid;
}

// "DEL" packed five bits per letter, as in a Dell EDID.
constexpr int64_t kDellProductCode = (int64_t{0x10AC} << 16) | 0x41A0;

// Profiles match on this name, as in kanshi and sway, because `display_id()`
// is an opaque number users cannot predict.
TEST(DrmScreenTest, ADisplayIsNamedByItsPanel) {
  auto snapshot = SnapshotBuilder()
                      .ProductCode(kDellProductCode)
                      .Name("DELL U3219Q")
                      .Edid(EdidWithSerial("2ZLS413"))
                      .Build();

  EXPECT_EQ(DisplayNameFromSnapshot(*snapshot), "DEL DELL U3219Q 2ZLS413");
  EXPECT_EQ(DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode()).label(), "DEL DELL U3219Q 2ZLS413");
}

// Identical monitors differ only by serial, which `display::EdidParser` keeps
// only as a hash.
TEST(DrmScreenTest, ThreeIdenticalMonitorsGetThreeDifferentNames) {
  auto left = SnapshotBuilder()
                  .ProductCode(kDellProductCode)
                  .Name("DELL U3219Q")
                  .Edid(EdidWithSerial("2ZLS413"))
                  .Build();
  auto center = SnapshotBuilder()
                    .ProductCode(kDellProductCode)
                    .Name("DELL U3219Q")
                    .Edid(EdidWithSerial("G3MS413"))
                    .Build();
  auto right = SnapshotBuilder()
                   .ProductCode(kDellProductCode)
                   .Name("DELL U3219Q")
                   .Edid(EdidWithSerial("H8KF413"))
                   .Build();

  EXPECT_EQ(DisplayNameFromSnapshot(*left), "DEL DELL U3219Q 2ZLS413");
  EXPECT_EQ(DisplayNameFromSnapshot(*center), "DEL DELL U3219Q G3MS413");
  EXPECT_EQ(DisplayNameFromSnapshot(*right), "DEL DELL U3219Q H8KF413");
}

// `kInvalidProductCode` decodes to three backticks, which would look like a
// real make. The make is dropped instead.
TEST(DrmScreenTest, ADisplayWithNoProductCodeIsNotNamedAfterTheArithmetic) {
  auto snapshot = SnapshotBuilder()
                      .Name("DELL U3219Q")
                      .Edid(EdidWithSerial("2ZLS413"))
                      .Build();

  EXPECT_EQ(DisplayNameFromSnapshot(*snapshot), "DELL U3219Q 2ZLS413");
}

// The label stays unset rather than "", so identical empty labels do not
// look like real names.
TEST(DrmScreenTest, ADisplayThatNamesItselfNothingIsLeftUnnamed) {
  auto snapshot = SnapshotBuilder().Name("").Build();

  EXPECT_EQ(DisplayNameFromSnapshot(*snapshot), "");
  EXPECT_TRUE(DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode()).label().empty());
}

TEST(DrmScreenTest, ADisplayTakesItsBoundsFromTheSnapshotsNativeMode) {
  auto snapshot = SnapshotBuilder()
                      .Id(7)
                      .Origin(gfx::Point(0, 0))
                      .NativeMode(gfx::Size(2560, 1440), 144.f)
                      .Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  EXPECT_EQ(display.id(), 7);
  EXPECT_EQ(display.bounds(), gfx::Rect(0, 0, 2560, 1440));
}

TEST(DrmScreenTest, ADisplayIsPlacedAtTheSnapshotsOrigin) {
  auto snapshot = SnapshotBuilder()
                      .Origin(gfx::Point(1920, 0))
                      .NativeMode(gfx::Size(1280, 1024), 60.f)
                      .Build();

  EXPECT_EQ(DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode()).bounds(),
            gfx::Rect(1920, 0, 1280, 1024));
}

// The compositor can only learn the physical size through this conversion.
TEST(DrmScreenTest, APhysicalSizeInMillimetersSurvivesTheConversion) {
  auto snapshot = SnapshotBuilder().PhysicalSizeMm(gfx::Size(597, 336)).Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  EXPECT_EQ(display.native_origin(), gfx::Point());
  EXPECT_EQ(DisplayPhysicalSizeMm(*snapshot), gfx::Size(597, 336));
}

// `display::Display` has no physical size, so it travels as a DPI and
// `components/domicile/browser/display_list.cc` converts it back. Its test
// uses the same panel numbers.
TEST(DrmScreenTest, APanelsMillimetersCrossAsTheDpiTheyMakeWithTheMode) {
  auto snapshot = SnapshotBuilder()
                      .PhysicalSizeMm(gfx::Size(597, 336))
                      .NativeMode(gfx::Size(1920, 1080), 60.f)
                      .Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  // 1920 px over 597 mm is 81.7 DPI; 1080 px over 336 mm is 81.6. Per axis,
  // because pixels need not be square.
  EXPECT_NEAR(display.GetPixelsPerInchX(), 81.688f, 0.001f);
  EXPECT_NEAR(display.GetPixelsPerInchY(), 81.643f, 0.001f);
}

// On a tty the compositor has no card node, so this is its only source for
// the refresh rate.
TEST(DrmScreenTest, ADisplayTakesItsRefreshRateFromTheNativeMode) {
  auto snapshot =
      SnapshotBuilder().NativeMode(gfx::Size(2560, 1440), 143.998f).Build();

  EXPECT_FLOAT_EQ(DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode()).display_frequency(), 143.998f);
}

// Projectors and virtual outputs report no physical size. Zero density means
// unknown, as zero does in `wl_output`.
TEST(DrmScreenTest, AConnectorWithNoPhysicalSizeIsGivenNoDensity) {
  auto snapshot = SnapshotBuilder().PhysicalSizeMm(gfx::Size()).Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  EXPECT_EQ(display.GetPixelsPerInchX(), 0.f);
  EXPECT_EQ(display.GetPixelsPerInchY(), 0.f);
}

// Without a mode there is no rate, and no density, which needs both pixels
// and millimeters. Bounds still use the displayless fallback.
TEST(DrmScreenTest, AConnectorWithNoModeHasNeitherARateNorADensity) {
  auto snapshot = SnapshotBuilder()
                      .PhysicalSizeMm(gfx::Size(597, 336))
                      .NoNativeMode()
                      .Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  EXPECT_EQ(display.display_frequency(), 0.f);
  EXPECT_EQ(display.GetPixelsPerInchX(), 0.f);
}

TEST(DrmScreenTest, ASnapshotWithNoNativeModeStillProducesAUsableDisplay) {
  auto snapshot = SnapshotBuilder().Id(3).NoNativeMode().Build();

  const display::Display display = DisplayFromSnapshot(*snapshot, snapshot->origin(), snapshot->native_mode());

  EXPECT_EQ(display.id(), 3);
  EXPECT_FALSE(display.bounds().IsEmpty())
      << "a display with an empty bounds is one no window can be placed on";
}

// A tty with nothing connected is normal (all of `crux`'s connectors read
// disconnected). `PlatformScreen` must still have a primary display.
// Returns the format viz draws `display`'s opaque frames in.
viz::SharedImageFormat OpaqueFrameFormat(const display::Display& display) {
  return display.GetColorSpaces().GetOutputFormat(
      gfx::ContentColorUsage::kSRGB, /*needs_alpha=*/false);
}

// virtio-gpu's planes take only XR24 and AR24. A frame in the default AB24
// gets no framebuffer, so the screen stays black.
TEST(DrmScreenTest, ADisplayWhosePlanesTakeOnlyXrgbDrawsInBgra) {
  auto snapshot = SnapshotBuilder()
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(*snapshot, gfx::Point(), snapshot->native_mode())),
            viz::SinglePlaneFormat::kBGRA_8888);
}

TEST(DrmScreenTest, ADisplayWhosePlanesTakeXbgrKeepsTheDefaultFormat) {
  auto snapshot = SnapshotBuilder()
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_XBGR8888})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(*snapshot, gfx::Point(), snapshot->native_mode())),
            OpaqueFrameFormat(display::Display()));
}

// A 10-bit framebuffer on an XB30 plane holds viz's RGBA_1010102.
TEST(DrmScreenTest, ATenBitPanelOnPlanesThatTakeXbgrDrawsInRgba1010102) {
  auto snapshot = SnapshotBuilder()
                      .BitsPerChannel(10)
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_XBGR8888,
                                     DRM_FORMAT_XRGB2101010,
                                     DRM_FORMAT_XBGR2101010})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(
                *snapshot, gfx::Point(), snapshot->native_mode())),
            viz::SinglePlaneFormat::kRGBA_1010102);
}

TEST(DrmScreenTest, ATenBitPanelOnPlanesThatTakeOnlyXrgbDrawsInBgra1010102) {
  auto snapshot = SnapshotBuilder()
                      .BitsPerChannel(10)
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_XBGR8888,
                                     DRM_FORMAT_XRGB2101010})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(
                *snapshot, gfx::Point(), snapshot->native_mode())),
            viz::SinglePlaneFormat::kBGRA_1010102);
}

// Its EDID says 8 bits reach the panel, so 10-bit frames would only cost
// memory.
TEST(DrmScreenTest, AnEightBitPanelDrawsInEightBitsWhateverThePlanesTake) {
  auto snapshot = SnapshotBuilder()
                      .BitsPerChannel(8)
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_XBGR8888,
                                     DRM_FORMAT_XBGR2101010})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(
                *snapshot, gfx::Point(), snapshot->native_mode())),
            OpaqueFrameFormat(display::Display()));
}

// A DisplayLink dock's planes take only XR24 and AR24.
TEST(DrmScreenTest, ATenBitPanelOnEightBitPlanesDrawsInEightBits) {
  auto snapshot = SnapshotBuilder()
                      .BitsPerChannel(10)
                      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888})
                      .Build();

  EXPECT_EQ(OpaqueFrameFormat(DisplayFromSnapshot(
                *snapshot, gfx::Point(), snapshot->native_mode())),
            viz::SinglePlaneFormat::kBGRA_8888);
}

// An EDID HDR block that takes PQ and peaks at `peak_nits`.
gfx::HDRStaticMetadata TakesPq(double peak_nits) {
  return gfx::HDRStaticMetadata(
      peak_nits, peak_nits / 2, 0.05,
      gfx::HDRStaticMetadata::EotfMask(
          {gfx::HDRStaticMetadata::Eotf::kGammaSdrRange,
           gfx::HDRStaticMetadata::Eotf::kPq}));
}

// A 10-bit panel on 10-bit planes whose EDID takes PQ.
SnapshotBuilder AnHdrPanel(double peak_nits) {
  SnapshotBuilder builder;
  builder.Id(11)
      .BitsPerChannel(10)
      .PlaneFormats({DRM_FORMAT_XRGB8888, DRM_FORMAT_XBGR8888,
                     DRM_FORMAT_XBGR2101010})
      .HdrMetadata(TakesPq(peak_nits));
  return builder;
}

TEST(DrmScreenTest, AnHdrPanelAskedForHdrDrawsInHdr10) {
  auto snapshot = AnHdrPanel(800).Build();
  const DomicileDisplayLayout wanted{
      .id = 11, .enabled = true, .hdr = true, .sdr_white_nits = 200.f};

  ASSERT_TRUE(DrivesHdr(*snapshot, &wanted));
  const gfx::DisplayColorSpaces drawn =
      HdrColorSpaces(*snapshot, 200.f, viz::SinglePlaneFormat::kRGBA_1010102);

  EXPECT_EQ(drawn.GetOutputColorSpace(gfx::ContentColorUsage::kHDR, false),
            gfx::ColorSpace::CreateHDR10());
  EXPECT_EQ(drawn.GetOutputFormat(gfx::ContentColorUsage::kHDR, false),
            viz::SinglePlaneFormat::kRGBA_1010102);
  EXPECT_FLOAT_EQ(drawn.GetSDRMaxLuminanceNits(), 200.f);
  EXPECT_FLOAT_EQ(drawn.GetHDRMaxLuminanceRelative(), 4.f)
      << "800 cd/m² over a 200 cd/m² white";
}

TEST(DrmScreenTest, AnHdrPanelReportingNoPeakIsTakenToReachAThousandNits) {
  auto snapshot = AnHdrPanel(0).Build();

  EXPECT_FLOAT_EQ(
      HdrColorSpaces(*snapshot, 250.f, viz::SinglePlaneFormat::kRGBA_1010102)
          .GetHDRMaxLuminanceRelative(),
      kUnreportedPeakNits / 250.f);
}

TEST(DrmScreenTest, AWhiteBrighterThanThePanelsPeakGetsNoHeadroom) {
  auto snapshot = AnHdrPanel(300).Build();

  EXPECT_FLOAT_EQ(
      HdrColorSpaces(*snapshot, 400.f, viz::SinglePlaneFormat::kRGBA_1010102)
          .GetHDRMaxLuminanceRelative(),
      1.f);
}

TEST(DrmScreenTest, APanelWithoutPqOrTenBitsIsNotDrivenInHdr) {
  const DomicileDisplayLayout wanted{.id = 11, .enabled = true, .hdr = true};
  auto no_pq = AnHdrPanel(800)
                   .HdrMetadata(gfx::HDRStaticMetadata(
                       800, 400, 0.05,
                       gfx::HDRStaticMetadata::EotfMask(
                           {gfx::HDRStaticMetadata::Eotf::kGammaSdrRange})))
                   .Build();
  auto eight_bit = AnHdrPanel(800).BitsPerChannel(8).Build();
  auto eight_bit_planes =
      AnHdrPanel(800).PlaneFormats({DRM_FORMAT_XRGB8888}).Build();

  for (const auto* snapshot :
       {no_pq.get(), eight_bit.get(), eight_bit_planes.get()}) {
    EXPECT_FALSE(DrivesHdr(*snapshot, &wanted));
    EXPECT_EQ(HdrOf(*snapshot, &wanted), DomicileHdr::kUnsupported);
  }
}

TEST(DrmScreenTest, AnHdrPanelNotAskedForHdrStaysSdr) {
  auto snapshot = AnHdrPanel(800).Build();
  const DomicileDisplayLayout unasked{.id = 11, .enabled = true};
  const DomicileDisplayLayout dark{.id = 11, .enabled = false, .hdr = true};

  EXPECT_FALSE(DrivesHdr(*snapshot, nullptr));
  EXPECT_FALSE(DrivesHdr(*snapshot, &unasked));
  EXPECT_FALSE(DrivesHdr(*snapshot, &dark));
  EXPECT_EQ(HdrOf(*snapshot, &unasked), DomicileHdr::kOff);
}

TEST(DrmScreenTest, NoSnapshotsAtAllStillYieldsOnePrimaryDisplay) {
  // `raw_ptr<T>` and `raw_ptr<T, DanglingUntriaged>` are distinct types, and
  // vectors of them do not convert.
  const std::vector<display::Display> displays = DisplaysFromSnapshots(
      std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>(), {});

  ASSERT_EQ(displays.size(), 1u)
      << "a tty with nothing plugged in still has to answer GetPrimaryDisplay";
  EXPECT_FALSE(displays.front().bounds().IsEmpty());
}

// Returns raw pointers to `owned`, as the delegate passes snapshots.
std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> Pointers(
    const std::vector<std::unique_ptr<display::DisplaySnapshot>>& owned) {
  std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> pointers;
  for (const std::unique_ptr<display::DisplaySnapshot>& snapshot : owned) {
    pointers.push_back(snapshot.get());
  }
  return pointers;
}

class RecordingObserver : public display::DisplayObserver {
 public:
  void OnDisplayAdded(const display::Display& display) override {
    added_.push_back(display.id());
  }

  void OnDisplayMetricsChanged(const display::Display& display,
                               uint32_t changed_metrics) override {
    changed_metrics_.push_back(changed_metrics);
  }

  const std::vector<int64_t>& added() const { return added_; }

  // The changed-metrics flags of each change, in order.
  std::vector<uint32_t> changed_metrics_;

 private:
  std::vector<int64_t> added_;
};

// Returns the bounds of display `id`, regardless of list order.
gfx::Rect BoundsOf(const DrmScreen& screen, int64_t id) {
  for (const display::Display& display : screen.GetAllDisplays()) {
    if (display.id() == id) {
      return display.bounds();
    }
  }
  ADD_FAILURE() << "no display " << id << " in the list";
  return gfx::Rect();
}

TEST(DrmScreenTest, TheFirstSnapshotIsThePrimaryDisplay) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(
      SnapshotBuilder().Id(12).Origin(gfx::Point(1920, 0)).Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.GetAllDisplays().size(), 2u);
  EXPECT_EQ(screen.GetPrimaryDisplay().id(), 11);
}

// A profile often turns off the laptop panel, which is usually the first
// connector. A dark primary would draw the desktop onto a screen nobody sees.
TEST(DrmScreenTest, ThePrimaryIsTheFirstDisplayTheLayoutLights) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());

  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11, .enabled = false, .origin = gfx::Point(1920, 0)},
       {.id = 12, .enabled = true, .origin = gfx::Point(0, 0)}});

  EXPECT_EQ(screen.GetPrimaryDisplay().id(), 12);
}

// `DisplayList::AddDisplay` DCHECKs that the first display is primary, and
// this build has `dcheck_always_on`. The display event's mojom also promises
// the list primary first.
TEST(DrmScreenTest, TheListArrivesPrimaryFirst) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());

  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11, .enabled = false, .origin = gfx::Point(1920, 0)},
       {.id = 12, .enabled = true, .origin = gfx::Point(0, 0)}});

  ASSERT_EQ(screen.GetAllDisplays().size(), 2u);
  EXPECT_EQ(screen.GetAllDisplays().front().id(), 12);
}

TEST(DrmScreenTest, WithNoLayoutThePrimaryIsStillTheFirstDisplay) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  snapshots.push_back(SnapshotBuilder().Id(12).Build());

  EXPECT_EQ(PrimaryIndexForLayout(Pointers(snapshots), {}), 0u);
}

// Dark connectors still need a place. Left at the card's origin, two displays
// would share a rectangle, and the first would win every `GetDisplayMatching`
// lookup, including the one that sizes a fullscreen window.
TEST(DrmScreenTest, ADisplayTakesTheCornerTheLayoutGivesIt) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder()
                          .Id(11)
                          .Origin(gfx::Point(0, 0))
                          .NativeMode(gfx::Size(2880, 1920), 120.f)
                          .Build());
  snapshots.push_back(SnapshotBuilder()
                          .Id(12)
                          .Origin(gfx::Point(0, 0))
                          .NativeMode(gfx::Size(3840, 2160), 60.f)
                          .Build());

  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11, .enabled = false, .origin = gfx::Point(3840, 0)},
       {.id = 12, .enabled = true, .origin = gfx::Point(0, 0)}});

  // Look up by id; `TheListArrivesPrimaryFirst` covers the order.
  ASSERT_EQ(screen.GetAllDisplays().size(), 2u);
  EXPECT_EQ(BoundsOf(screen, 11), gfx::Rect(3840, 0, 2880, 1920))
      << "the dark panel is placed out of the lit one's way";
  EXPECT_EQ(BoundsOf(screen, 12), gfx::Rect(0, 0, 3840, 2160));
}

// Ozone reports (0, 0) for a connector it has not read before, and a desk
// whose monitors are still arriving has no layout yet. Displays sharing a
// rectangle share a window, and the other CRTC stays black.
TEST(DrmScreenTest, WithNoLayoutTheConnectorsAreARowInConnectorOrder) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  for (const int64_t id : {11, 12, 13}) {
    snapshots.push_back(SnapshotBuilder()
                            .Id(id)
                            .Origin(gfx::Point(0, 0))
                            .NativeMode(gfx::Size(3840, 2160), 60.f)
                            .Build());
  }

  EXPECT_EQ(OriginsForLayout(Pointers(snapshots), {}),
            std::vector<gfx::Point>(
                {gfx::Point(0, 0), gfx::Point(3840, 0), gfx::Point(7680, 0)}));
}

// A monitor plugged in after the compositor's last layout. Its card origin
// overlaps a placed display, so it goes past them instead.
TEST(DrmScreenTest, AConnectorTheLayoutDoesNotNameGoesPastEverythingItDoes) {
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(3840, 2160), 60.f).Build());
  snapshots.push_back(
      SnapshotBuilder().Id(12).NativeMode(gfx::Size(3840, 2160), 60.f).Build());
  snapshots.push_back(SnapshotBuilder()
                          .Id(13)
                          .Origin(gfx::Point(0, 0))
                          .NativeMode(gfx::Size(3840, 2160), 60.f)
                          .Build());
  snapshots.push_back(SnapshotBuilder().Id(14).NoNativeMode().Build());

  EXPECT_EQ(OriginsForLayout(
                Pointers(snapshots),
                {{.id = 11, .enabled = true, .origin = gfx::Point(2160, 0)},
                 {.id = 12, .enabled = true, .origin = gfx::Point(0, 0)}}),
            std::vector<gfx::Point>({gfx::Point(2160, 0), gfx::Point(0, 0),
                                     gfx::Point(6000, 0), gfx::Point(9840, 0)}))
      << "past the right edge of everything the layout placed, in connector "
         "order";
}

display::Display DisplayOf(const DrmScreen& screen, int64_t id) {
  for (const display::Display& display : screen.GetAllDisplays()) {
    if (display.id() == id) {
      return display;
    }
  }
  ADD_FAILURE() << "no display " << id << " in the list";
  return display::Display();
}

// Views rotates each window and pages lay out at its scale, so shells work in
// upright logical pixels.
//
// The layout counts counterclockwise, as `wl_output` does;
// `display::Display::Rotation` counts clockwise. A panel on its left side is
// `rotate-270` in one and ROTATE_90 in the other.
TEST(DrmScreenTest, ADisplayTakesTheTurnAndScaleTheLayoutGivesIt) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(3840, 2160), 60.f).Build());
  snapshots.push_back(
      SnapshotBuilder().Id(12).NativeMode(gfx::Size(3840, 2160), 60.f).Build());

  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11,
        .enabled = true,
        .origin = gfx::Point(0, 0),
        .transform = DomicileDisplayLayout::Transform::kRotate270,
        .scale = 1.2},
       {.id = 12,
        .enabled = true,
        .origin = gfx::Point(3840, 0),
        .transform = DomicileDisplayLayout::Transform::kRotate90,
        .scale = 2.0}});

  const display::Display left = DisplayOf(screen, 11);
  EXPECT_EQ(left.rotation(), display::Display::ROTATE_90);
  EXPECT_FLOAT_EQ(left.device_scale_factor(), 1.2f);
  EXPECT_EQ(DisplayOf(screen, 12).rotation(), display::Display::ROTATE_270);
  EXPECT_FLOAT_EQ(DisplayOf(screen, 12).device_scale_factor(), 2.f);

  // Bounds stay in CRTC pixels: windows bind to CRTCs on an exact match,
  // fullscreen windows are sized from them, and the compositor places
  // connectors in them.
  EXPECT_EQ(left.bounds(), gfx::Rect(0, 0, 3840, 2160));
  EXPECT_EQ(left.GetSizeInPixel(), gfx::Size(3840, 2160))
      << "the panel's pixels, rather than its bounds multiplied by a scale "
         "they are not in";
}

TEST(DrmScreenTest, AProfileThatAsksForHdrDrawsTheDisplayInHdr10) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(AnHdrPanel(800).Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {{.id = 11, .enabled = true}});
  const gfx::DisplayColorSpaces sdr = DisplayOf(screen, 11).GetColorSpaces();
  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11, .enabled = true, .hdr = true, .sdr_white_nits = 200.f}});
  const gfx::DisplayColorSpaces hdr = DisplayOf(screen, 11).GetColorSpaces();

  EXPECT_NE(sdr.GetOutputColorSpace(gfx::ContentColorUsage::kSRGB, false),
            gfx::ColorSpace::CreateHDR10());
  EXPECT_EQ(hdr.GetOutputColorSpace(gfx::ContentColorUsage::kSRGB, false),
            gfx::ColorSpace::CreateHDR10())
      << "the connector is in PQ, so SDR content is drawn into it too";
  EXPECT_EQ(hdr.GetOutputFormat(gfx::ContentColorUsage::kHDR, false),
            viz::SinglePlaneFormat::kRGBA_1010102)
      << "the 10-bit format the planes took";
  EXPECT_FLOAT_EQ(hdr.GetSDRMaxLuminanceNits(), 200.f);
}

TEST(DrmScreenTest, ADisplayTheLayoutSaysNothingAboutIsUprightAndUnscaled) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(3840, 2160), 60.f).Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(DisplayOf(screen, 11).rotation(), display::Display::ROTATE_0);
  EXPECT_FLOAT_EQ(DisplayOf(screen, 11).device_scale_factor(), 1.f);
}

// A profile reload is not a hotplug, but views must still rotate and rescale
// the existing window.
TEST(DrmScreenTest, AProfileThatTurnsAMonitorTellsItsObservers) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(3840, 2160), 60.f).Build());
  screen.OnDisplaysChanged(Pointers(snapshots), {});

  RecordingObserver observer;
  screen.AddObserver(&observer);
  screen.OnDisplaysChanged(
      Pointers(snapshots),
      {{.id = 11,
        .enabled = true,
        .origin = gfx::Point(0, 0),
        .transform = DomicileDisplayLayout::Transform::kRotate270,
        .scale = 1.2}});
  screen.RemoveObserver(&observer);

  ASSERT_EQ(observer.changed_metrics_.size(), 1u);
  EXPECT_TRUE(observer.changed_metrics_[0] &
              display::DisplayObserver::DISPLAY_METRIC_ROTATION);
  EXPECT_TRUE(observer.changed_metrics_[0] &
              display::DisplayObserver::DISPLAY_METRIC_DEVICE_SCALE_FACTOR);
}

// `OzonePlatformDrm::InitScreen` does this before the modeset driver runs.
TEST(DrmScreenTest, AScreenToldOfNoDisplaysStillAnswersWithAPrimary) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);

  screen.OnDisplaysChanged({}, {});

  EXPECT_FALSE(screen.GetPrimaryDisplay().bounds().IsEmpty());
}

// Each update carries the whole list, so a display missing from it is
// removed.
TEST(DrmScreenTest, AHotplugReplacesTheListRatherThanAppendingToIt) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> unplugged;
  unplugged.push_back(SnapshotBuilder().Id(11).Build());
  screen.OnDisplaysChanged(Pointers(unplugged), {});
  std::vector<std::unique_ptr<display::DisplaySnapshot>> plugged;
  plugged.push_back(SnapshotBuilder().Id(12).Build());

  screen.OnDisplaysChanged(Pointers(plugged), {});

  ASSERT_EQ(screen.GetAllDisplays().size(), 1u);
  EXPECT_EQ(screen.GetAllDisplays().front().id(), 12);
}

// `DisplayList` notifies observers itself, so `DrmScreen` needs no observer
// code.
TEST(DrmScreenTest, AHotplugReachesADisplayObserver) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  RecordingObserver observer;
  screen.AddObserver(&observer);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(observer.added(), std::vector<int64_t>{11});
  screen.RemoveObserver(&observer);
}

// The compositor names a monitor with no EDID name after its connector.
TEST(DrmScreenTest, TheScreenKnowsEachDisplaysConnector) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Connector("eDP-1").Build());
  snapshots.push_back(SnapshotBuilder()
                          .Id(12)
                          .Origin(gfx::Point(1920, 0))
                          .Connector("HDMI-A-1")
                          .Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.connectors(),
            (base::flat_map<int64_t, std::string>{{11, "eDP-1"},
                                                  {12, "HDMI-A-1"}}));
}

// The compositor offers gamma control at each display's ramp size, and none
// where it is 0.
TEST(DrmScreenTest, TheScreenKnowsEachDisplaysGammaSize) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).GammaSize(4096).Build());
  snapshots.push_back(
      SnapshotBuilder().Id(12).Origin(gfx::Point(1920, 0)).Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.gamma_sizes(),
            (base::flat_map<int64_t, uint32_t>{{11, 4096}, {12, 0}}));
}

TEST(DrmScreenTest, AnUnpluggedDisplaysConnectorIsForgotten) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> unplugged;
  unplugged.push_back(SnapshotBuilder().Id(11).Connector("DP-1").Build());
  screen.OnDisplaysChanged(Pointers(unplugged), {});
  std::vector<std::unique_ptr<display::DisplaySnapshot>> plugged;
  plugged.push_back(SnapshotBuilder().Id(12).Connector("DP-2").Build());

  screen.OnDisplaysChanged(Pointers(plugged), {});

  EXPECT_EQ(screen.connectors(),
            (base::flat_map<int64_t, std::string>{{12, "DP-2"}}));
}

// Records the connector the screen gives each display as it is added.
class ConnectorObserver : public display::DisplayObserver {
 public:
  explicit ConnectorObserver(const DrmScreen* screen) : screen_(screen) {}

  void OnDisplayAdded(const display::Display& display) override {
    const auto connector = screen_->connectors().find(display.id());
    heard_.push_back(connector == screen_->connectors().end()
                         ? std::string()
                         : connector->second);
  }

  const std::vector<std::string>& heard() const { return heard_; }

 private:
  const raw_ptr<const DrmScreen> screen_;
  std::vector<std::string> heard_;
};

// The browser reads the connectors when the display list notifies it, so they
// must be current by then.
TEST(DrmScreenTest, AnObserverOfAHotplugReadsTheNewDisplaysConnector) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  ConnectorObserver observer(&screen);
  screen.AddObserver(&observer);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Connector("HDMI-A-1").Build());

  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(observer.heard(), std::vector<std::string>{"HDMI-A-1"});
  screen.RemoveObserver(&observer);
}

TEST(DrmScreenTest, APointBelongsToTheDisplayItFallsOn) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(1920, 1080), 60.f).Build());
  snapshots.push_back(SnapshotBuilder()
                          .Id(12)
                          .Origin(gfx::Point(1920, 0))
                          .NativeMode(gfx::Size(1280, 1024), 60.f)
                          .Build());
  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.GetDisplayNearestPoint(gfx::Point(2000, 10)).id(), 12);
}

TEST(DrmScreenTest, ARectBelongsToTheDisplayItOverlapsMost) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(
      SnapshotBuilder().Id(11).NativeMode(gfx::Size(1920, 1080), 60.f).Build());
  snapshots.push_back(SnapshotBuilder()
                          .Id(12)
                          .Origin(gfx::Point(1920, 0))
                          .NativeMode(gfx::Size(1280, 1024), 60.f)
                          .Build());
  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.GetDisplayMatching(gfx::Rect(1820, 0, 400, 200)).id(), 12);
}

// `DrmWindowHostManager::GetWindow()` is NOTREACHED() for an unknown widget,
// and this receives widgets from other screens.
TEST(DrmScreenTest, AWidgetWithNoWindowGetsThePrimaryRatherThanACrash) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);
  std::vector<std::unique_ptr<display::DisplaySnapshot>> snapshots;
  snapshots.push_back(SnapshotBuilder().Id(11).Build());
  screen.OnDisplaysChanged(Pointers(snapshots), {});

  EXPECT_EQ(screen.GetDisplayForAcceleratedWidget(
                static_cast<gfx::AcceleratedWidget>(7))
                .id(),
            11);
}

// `PlatformScreen`'s defaults return the same values, so these tests record the
// intended answers: no screen saver, and no idle time. Changing either means
// changing a test.
TEST(DrmScreenTest, NoOtherClientIsHoldingTheScreen) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);

  EXPECT_FALSE(screen.IsScreenSaverActive());
}

TEST(DrmScreenTest, IdleIsTheCompositorsToMeasureAndSoIsReportedAsNone) {
  DrmWindowHostManager window_manager;
  DrmScreen screen(&window_manager, nullptr);

  EXPECT_TRUE(screen.CalculateIdleTime().is_zero());
}

}  // namespace
}  // namespace ui
