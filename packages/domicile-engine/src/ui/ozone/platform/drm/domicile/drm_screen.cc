// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_screen.h"

#include <drm_fourcc.h>
#include <stddef.h>
#include <stdint.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <optional>
#include <vector>

#include "base/check.h"
#include "base/logging.h"
#include "base/notreached.h"
#include "base/containers/flat_set.h"
#include "components/viz/common/resources/shared_image_format.h"
#include "ui/display/display_finder.h"
#include "ui/display/display_observer.h"
#include "ui/display/types/display_constants.h"
#include "ui/display/types/display_mode.h"
#include "ui/display/util/edid_parser.h"
#include "ui/gfx/display_color_spaces.h"
#include "ui/ozone/platform/drm/domicile/drm_pointer_crossing.h"
#include "ui/ozone/platform/drm/domicile/edid_name.h"
#include "ui/ozone/platform/drm/domicile/hdr_output.h"
#include "ui/ozone/platform/drm/domicile/ten_bit_scanout.h"
#include "ui/ozone/platform/drm/host/drm_cursor.h"
#include "ui/ozone/platform/drm/host/drm_window_host.h"
#include "ui/ozone/platform/drm/host/drm_window_host_manager.h"

namespace ui {

namespace {

// Returns the layout entry for connector `id`, or null if it has none.
//
// Duplicated in drm_modeset.cc. Two callers do not justify a shared header.
const DomicileDisplayLayout* WantedFor(
    const std::vector<DomicileDisplayLayout>& layout,
    int64_t id) {
  for (const DomicileDisplayLayout& wanted : layout) {
    if (wanted.id == id) {
      return &wanted;
    }
  }
  return nullptr;
}

// Converts the layout's transform to a display::Display rotation.
//
// The layout counts rotation counterclockwise (`wl_output.transform`);
// display::Display counts clockwise. So the quarter turns swap.
display::Display::Rotation RotationOf(DomicileDisplayLayout::Transform turn) {
  switch (turn) {
    case DomicileDisplayLayout::Transform::kNormal:
      return display::Display::ROTATE_0;
    case DomicileDisplayLayout::Transform::kRotate90:
      return display::Display::ROTATE_270;
    case DomicileDisplayLayout::Transform::kRotate180:
      return display::Display::ROTATE_180;
    case DomicileDisplayLayout::Transform::kRotate270:
      return display::Display::ROTATE_90;
  }
}

// Applies the layout's rotation and scale to `screen`. Bounds stay in CRTC
// pixels; see `DisplaysFromSnapshots`.
void TurnAndScale(display::Display& screen,
                  const DomicileDisplayLayout& wanted) {
  // Read before setting the scale: `GetSizeInPixel` returns bounds times
  // scale until set explicitly, and these bounds are already pixels.
  const gfx::Size pixels = screen.bounds().size();
  screen.set_rotation(RotationOf(wanted.transform));
  screen.set_device_scale_factor(static_cast<float>(wanted.scale));
  screen.set_size_in_pixels(pixels);
}

// Draws `screen`'s frames in BGRA_8888 when the device's planes take no
// XBGR8888.
//
// Linux's default frame format, RGBA_8888, scans out through an AB24
// framebuffer on an XB24 plane. virtio-gpu takes only XR24 and AR24, so those
// frames get no framebuffer and the screen stays black. BGRA_8888 uses AR24
// and XR24, as on ChromeOS.
void DrawInAFormatThePlanesTake(display::Display& screen,
                                const display::DisplaySnapshot& snapshot) {
  if (snapshot.GetDRMFormatsAndModifiers().contains(DRM_FORMAT_XBGR8888)) {
    return;
  }
  gfx::DisplayColorSpaces color_spaces = screen.GetColorSpaces();
  color_spaces.SetOutputFormats(viz::SinglePlaneFormat::kBGRA_8888,
                                viz::SinglePlaneFormat::kBGRA_8888);
  screen.SetColorSpaces(color_spaces);
}

// Draws `screen`'s frames in 10 bits a channel where its panel and planes
// take them; see `TenBitScanoutFourcc`. Viz names channels in memory order, so
// XBGR2101010 is RGBA_1010102.
void DrawInTenBitsWhereThePanelTakesThem(
    display::Display& screen,
    const display::DisplaySnapshot& snapshot) {
  const std::optional<uint32_t> fourcc = TenBitScanoutFourcc(snapshot);
  if (!fourcc) {
    return;
  }
  const viz::SharedImageFormat format =
      *fourcc == DRM_FORMAT_XBGR2101010
          ? viz::SinglePlaneFormat::kRGBA_1010102
          : viz::SinglePlaneFormat::kBGRA_1010102;
  gfx::DisplayColorSpaces color_spaces = screen.GetColorSpaces();
  color_spaces.SetOutputFormats(format, format);
  screen.SetColorSpaces(color_spaces);
}

// Draws `screen`'s frames in HDR10, in the 10-bit format
// `DrawInTenBitsWhereThePanelTakesThem` picked.
void DrawInHdr(display::Display& screen,
               const display::DisplaySnapshot& snapshot,
               float sdr_white_nits) {
  const gfx::DisplayColorSpaces drawn = screen.GetColorSpaces();
  screen.SetColorSpaces(HdrColorSpaces(
      snapshot, sdr_white_nits,
      drawn.GetOutputFormat(gfx::ContentColorUsage::kHDR, false)));
}

// Returns `mode`'s size, or the displayless bounds if there is none.
gfx::Size SizeOf(const display::DisplayMode* mode) {
  return mode ? mode->size() : kDisplaylessBounds;
}

// Returns the size of the mode the layout picks for the snapshot.
gfx::Size SizeOf(const display::DisplaySnapshot& snapshot,
                 const std::vector<DomicileDisplayLayout>& layout) {
  return SizeOf(
      ModeForLayout(snapshot, WantedFor(layout, snapshot.display_id())));
}

// A mode's refresh rate in mHz, as wl_output states it.
int32_t MillihertzOf(const display::DisplayMode& mode) {
  return static_cast<int32_t>(std::lround(mode.refresh_rate() * 1000.f));
}

// Whether `mode` beats `chosen`, both of one size, for a profile asking for
// `refresh_mhz` (zero for none).
//
// A progressive mode beats an interlaced one, which halves the vertical
// resolution each frame. Then the rate nearest the one asked for, or with
// none the fastest, as sway picks.
bool Better(const display::DisplayMode& mode,
            const display::DisplayMode& chosen,
            int32_t refresh_mhz) {
  if (mode.is_interlaced() != chosen.is_interlaced()) {
    return chosen.is_interlaced();
  }
  if (refresh_mhz > 0) {
    return std::abs(MillihertzOf(mode) - refresh_mhz) <
           std::abs(MillihertzOf(chosen) - refresh_mhz);
  }
  return mode.refresh_rate() > chosen.refresh_rate();
}

}  // namespace

const display::DisplayMode* ModeForLayout(
    const display::DisplaySnapshot& snapshot,
    const DomicileDisplayLayout* wanted) {
  const display::DisplayMode* native_mode = snapshot.native_mode();
  if (!native_mode || !wanted) {
    return native_mode;
  }
  const gfx::Size size = wanted->mode.value_or(native_mode->size());
  if (size == native_mode->size() && wanted->refresh_mhz <= 0) {
    return native_mode;
  }
  const display::DisplayMode* chosen = nullptr;
  for (const std::unique_ptr<const display::DisplayMode>& mode :
       snapshot.modes()) {
    if (mode->size() != size) {
      continue;
    }
    if (!chosen || Better(*mode, *chosen, wanted->refresh_mhz)) {
      chosen = mode.get();
    }
  }
  return chosen ? chosen : native_mode;
}

DomicilePanel PanelFromSnapshot(
    const display::DisplaySnapshot& snapshot,
    const std::vector<DomicileDisplayLayout>& layout) {
  DomicilePanel panel;
  panel.modes.reserve(snapshot.modes().size());
  for (const std::unique_ptr<const display::DisplayMode>& mode :
       snapshot.modes()) {
    panel.modes.push_back(
        {.size = mode->size(), .refresh_mhz = MillihertzOf(*mode)});
  }
  const display::DisplayMode* lit =
      ModeForLayout(snapshot, WantedFor(layout, snapshot.display_id()));
  panel.refresh_mhz = lit ? MillihertzOf(*lit) : 0;
  panel.physical_size_mm = DisplayPhysicalSizeMm(snapshot);
  panel.adaptive_sync = AdaptiveSyncOf(snapshot);
  const DomicileDisplayLayout* wanted = WantedFor(layout, snapshot.display_id());
  panel.hdr = HdrOf(snapshot, wanted);
  if (const std::optional<gfx::HDRStaticMetadata>& metadata =
          snapshot.hdr_static_metadata()) {
    panel.max_luminance = static_cast<float>(metadata->max);
    panel.max_average_luminance = static_cast<float>(metadata->max_avg);
    panel.min_luminance = static_cast<float>(metadata->min);
  }
  if (panel.hdr == DomicileHdr::kOn) {
    panel.sdr_white_nits = wanted->sdr_white_nits;
  }
  return panel;
}

bool PanelChangedUnseen(const DomicilePanel& before,
                        const DomicilePanel& after) {
  return before.refresh_mhz != after.refresh_mhz ||
         before.adaptive_sync != after.adaptive_sync ||
         before.hdr != after.hdr || before.sdr_white_nits != after.sdr_white_nits;
}

DomicileAdaptiveSync AdaptiveSyncOf(const display::DisplaySnapshot& snapshot) {
  // Read off the connector and CRTC when the snapshot was taken, so it says
  // what the hardware does, not what was asked for.
  switch (snapshot.variable_refresh_rate_state()) {
    case display::VariableRefreshRateState::kVrrNotCapable:
      return DomicileAdaptiveSync::kUnsupported;
    case display::VariableRefreshRateState::kVrrDisabled:
      return DomicileAdaptiveSync::kOff;
    case display::VariableRefreshRateState::kVrrEnabled:
      return DomicileAdaptiveSync::kOn;
  }
  NOTREACHED();
}

display::Display DisplayFromSnapshot(const display::DisplaySnapshot& snapshot,
                                     const gfx::Point& origin,
                                     const display::DisplayMode* mode) {
  // A connector with no mode gets the displayless bounds, since no window can
  // be placed on empty bounds.
  const gfx::Size size = SizeOf(mode);
  // Not named `display`: that would shadow the `display::` namespace used
  // below.
  display::Display screen(snapshot.display_id(), gfx::Rect(origin, size));

  // This is the only place the panel's data reaches display::Display, which
  // is all the browser process learns about a snapshot.
  //
  // display::Display has no physical size, so store it as DPI.
  // components/domicile/browser/display_list.cc converts it back. See
  // docs/DISPLAYS.md#physical-size-and-refresh.
  //
  // DisplayList::UpdateDisplay copies neither field, and a profile can change
  // a listed display's mode, so `DrmScreen::panels` carries both to the
  // browser too.
  if (mode) {
    screen.set_display_frequency(mode->refresh_rate());
  }
  // Zero millimeters means no physical size (a projector, a virtual output).
  // Leave the density unset rather than divide by zero.
  const gfx::Size millimeters = DisplayPhysicalSizeMm(snapshot);
  if (mode && !millimeters.IsEmpty()) {
    screen.set_pixels_per_inch(
        display::kInchInMm * mode->size().width() / millimeters.width(),
        display::kInchInMm * mode->size().height() /
            millimeters.height());
  }

  // Set only when non-empty, so an unnamed display keeps the default label.
  const std::string name = DisplayNameFromSnapshot(snapshot);
  if (!name.empty()) {
    screen.set_label(name);
  }
  DrawInAFormatThePlanesTake(screen, snapshot);
  DrawInTenBitsWhereThePanelTakesThem(screen, snapshot);
  return screen;
}

std::string DisplayNameFromSnapshot(const display::DisplaySnapshot& snapshot) {
  uint16_t manufacturer_id = 0;
  uint16_t product_id = 0;
  display::EdidParser::SplitProductCodeInManufacturerIdAndProductId(
      snapshot.product_code(), &manufacturer_id, &product_id);
  const std::string make =
      display::EdidParser::ManufacturerIdToString(manufacturer_id);

  // The logic lives in edid_name.cc, which has no Chromium types so it can
  // be tested outside a Chromium tree.
  return DisplayNameFrom(IsPnpId(make) ? make : std::string(),
                         snapshot.display_name(),
                         SerialNumberFromEdid(snapshot.edid()));
}

gfx::Size DisplayPhysicalSizeMm(const display::DisplaySnapshot& snapshot) {
  return snapshot.physical_size();
}

std::vector<display::Display> DisplaysFromSnapshots(
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots,
    const std::vector<DomicileDisplayLayout>& layout) {
  if (snapshots.empty()) {
    return {display::Display(display::kDefaultDisplayId,
                             gfx::Rect(kDisplaylessBounds))};
  }

  const std::vector<gfx::Point> origins = OriginsForLayout(snapshots, layout);
  std::vector<display::Display> displays;
  displays.reserve(snapshots.size());
  for (size_t index = 0; index < snapshots.size(); ++index) {
    const display::DisplaySnapshot* snapshot = snapshots[index];
    const DomicileDisplayLayout* wanted =
        WantedFor(layout, snapshot->display_id());
    display::Display screen = DisplayFromSnapshot(
        *snapshot, origins[index], ModeForLayout(*snapshot, wanted));
    if (wanted) {
      TurnAndScale(screen, *wanted);
    }
    if (DrivesHdr(*snapshot, wanted)) {
      DrawInHdr(screen, *snapshot, wanted->sdr_white_nits);
    }
    displays.push_back(screen);
  }
  return displays;
}

std::vector<gfx::Point> OriginsForLayout(
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots,
    const std::vector<DomicileDisplayLayout>& layout) {
  // Unplaced connectors start at the right edge of everything the layout
  // placed, or at zero if it placed nothing.
  int next_x = 0;
  for (const display::DisplaySnapshot* snapshot : snapshots) {
    const DomicileDisplayLayout* wanted =
        WantedFor(layout, snapshot->display_id());
    if (wanted) {
      next_x = std::max(next_x,
                        wanted->origin.x() + SizeOf(*snapshot, layout).width());
    }
  }

  std::vector<gfx::Point> origins;
  origins.reserve(snapshots.size());
  for (const display::DisplaySnapshot* snapshot : snapshots) {
    const DomicileDisplayLayout* wanted =
        WantedFor(layout, snapshot->display_id());
    if (wanted) {
      origins.push_back(wanted->origin);
    } else {
      origins.emplace_back(next_x, 0);
      next_x += SizeOf(*snapshot, layout).width();
    }
  }
  return origins;
}

size_t PrimaryIndexForLayout(
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots,
    const std::vector<DomicileDisplayLayout>& layout) {
  if (layout.empty()) {
    return 0u;
  }
  size_t index = 0;
  for (const display::DisplaySnapshot* snapshot : snapshots) {
    const DomicileDisplayLayout* wanted =
        WantedFor(layout, snapshot->display_id());
    if (wanted && wanted->enabled) {
      return index;
    }
    ++index;
  }
  // The config parser rejects a layout that lights nothing. Return the first
  // display anyway: `GetPrimaryDisplay` CHECKs that a primary exists.
  return 0u;
}

DrmScreen::DrmScreen(DrmWindowHostManager* window_manager, DrmCursor* cursor)
    : window_manager_(window_manager), cursor_(cursor) {}

DrmScreen::~DrmScreen() = default;

void DrmScreen::OnDisplaysChanged(
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots,
    const std::vector<DomicileDisplayLayout>& layout) {
  // A hotplug sends the whole list, so a display missing from it was
  // unplugged. DisplayList notifies observers itself.
  const std::vector<display::Display> displays =
      DisplaysFromSnapshots(snapshots, layout);

  // Before the list changes, so its observers read the new connectors.
  connectors_.clear();
  gamma_sizes_.clear();
  const base::flat_map<int64_t, DomicilePanel> before = std::move(panels_);
  panels_.clear();
  for (const display::DisplaySnapshot* snapshot : snapshots) {
    connectors_[snapshot->display_id()] = snapshot->domicile_connector();
    gamma_sizes_[snapshot->display_id()] = snapshot->domicile_gamma_size();
    panels_[snapshot->display_id()] = PanelFromSnapshot(*snapshot, layout);
  }

  // Not always the first snapshot: a profile may turn the laptop panel off.
  const size_t primary = PrimaryIndexForLayout(snapshots, layout);
  VLOG(1) << "domicile: " << snapshots.size() << " monitors, "
          << layout.size() << " laid out by the compositor, primary "
          << displays[primary].id();
  for (const display::Display& display : displays) {
    const auto connector = connectors_.find(display.id());
    VLOG(1) << "domicile: monitor " << display.id() << " ("
            << (connector != connectors_.end() ? connector->second : "")
            << "): " << display.ToString();
  }

  // Add the primary first: DisplayList::AddDisplay DCHECKs it, and this
  // build has `dcheck_always_on`. The display event's mojom also promises
  // primary first.
  base::flat_set<int64_t> still_here;
  display_list_.AddOrUpdateDisplay(displays[primary],
                                   display::DisplayList::Type::PRIMARY);
  still_here.insert(displays[primary].id());
  size_t index = 0;
  for (const display::Display& display : displays) {
    if (index != primary) {
      display_list_.AddOrUpdateDisplay(
          display, display::DisplayList::Type::NOT_PRIMARY);
      still_here.insert(display.id());
    }
    ++index;
  }

  // Collect first: RemoveDisplay erases from the vector being iterated.
  std::vector<int64_t> unplugged;
  for (const display::Display& display : display_list_.displays()) {
    if (!still_here.contains(display.id())) {
      unplugged.push_back(display.id());
    }
  }
  for (const int64_t id : unplugged) {
    VLOG(1) << "domicile: monitor " << id << " unplugged";
    display_list_.RemoveDisplay(id);
  }

  // DisplayList compares neither the refresh rate nor adaptive sync, so a
  // modeset that changed only those would reach no observer, and the
  // compositor would keep advertising the old ones.
  for (const display::Display& display : display_list_.displays()) {
    const auto was = before.find(display.id());
    const auto is = panels_.find(display.id());
    if (was != before.end() && is != panels_.end() &&
        PanelChangedUnseen(was->second, is->second)) {
      VLOG(1) << "domicile: monitor " << display.id()
              << " changed only its refresh rate or adaptive sync";
      for (display::DisplayObserver& observer :
           *display_list_.observers()) {
        observer.OnDisplayMetricsChanged(display, /*changed_metrics=*/0);
      }
    }
  }

  // A profile reload can rotate a display without moving its window, so
  // nothing else updates the pointer's rotation on it.
  for (const display::Display& display : display_list_.displays()) {
    DrmWindowHost* window =
        window_manager_->GetWindowAt(display.bounds().CenterPoint());
    if (window) {
      window->FollowDisplayTurn();
    }
  }
}

const std::vector<display::Display>& DrmScreen::GetAllDisplays() const {
  return display_list_.displays();
}

display::Display DrmScreen::GetPrimaryDisplay() const {
  // DisplaysFromSnapshots always returns a display, so this fails only if
  // called before OnDisplaysChanged.
  const auto primary = display_list_.GetPrimaryDisplayIterator();
  CHECK(primary != display_list_.displays().end());
  return *primary;
}

display::Display DrmScreen::GetDisplayForAcceleratedWidget(
    gfx::AcceleratedWidget widget) const {
  // GetWindow() is NOTREACHED() on unknown widgets, and callers pass widgets
  // from other screens.
  if (!window_manager_->HasWindow(widget)) {
    return GetPrimaryDisplay();
  }
  return GetDisplayMatching(
      window_manager_->GetWindow(widget)->GetBoundsInPixels());
}

gfx::Point DrmScreen::GetCursorScreenPoint() const {
  // aura synthesizes a mouse move from this, so return where the window
  // receiving pointer events (usually the desk's host) would see it.
  const std::optional<PointerHeard> heard = cursor_->Heard();
  if (!heard.has_value() || !window_manager_->HasWindow(heard->window)) {
    return gfx::Point();
  }
  return window_manager_->GetWindow(heard->window)
      ->ToScreenInDIP(heard->location);
}

gfx::AcceleratedWidget DrmScreen::GetAcceleratedWidgetAtScreenPoint(
    const gfx::Point& point_in_dip) const {
  // Screen coordinates are pixels here even on a scaled display, since
  // display bounds are CRTC pixels. See `DisplaysFromSnapshots`.
  const DrmWindowHost* window = window_manager_->GetWindowAt(point_in_dip);
  return window ? window->GetAcceleratedWidget() : gfx::kNullAcceleratedWidget;
}

display::Display DrmScreen::GetDisplayNearestPoint(
    const gfx::Point& point_in_dip) const {
  const display::Display* display =
      display::FindDisplayNearestPoint(display_list_.displays(), point_in_dip);
  return display ? *display : GetPrimaryDisplay();
}

display::Display DrmScreen::GetDisplayMatching(
    const gfx::Rect& match_rect) const {
  const display::Display* display = display::FindDisplayWithBiggestIntersection(
      display_list_.displays(), match_rect);
  return display ? *display : GetPrimaryDisplay();
}

bool DrmScreen::IsScreenSaverActive() const {
  // Overridden to avoid PlatformScreen's NOTIMPLEMENTED log. Domicile is the
  // compositor, so no other client can run a screen saver; blanking is the
  // shell's decision.
  return false;
}

base::TimeDelta DrmScreen::CalculateIdleTime() const {
  // Input goes to the compositor over evdev, so this screen cannot measure
  // idle time. Zero means "not idle".
  return base::Seconds(0);
}

void DrmScreen::AddObserver(display::DisplayObserver* observer) {
  display_list_.AddObserver(observer);
}

void DrmScreen::RemoveObserver(display::DisplayObserver* observer) {
  display_list_.RemoveObserver(observer);
}

}  // namespace ui
