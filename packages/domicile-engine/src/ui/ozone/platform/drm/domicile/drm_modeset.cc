// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_modeset.h"

#include <stddef.h>
#include <stdint.h>

#include <algorithm>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "ui/display/types/display_color_management.h"
#include "ui/display/types/display_constants.h"
#include "ui/display/types/display_mode.h"
#include "ui/display/types/display_snapshot.h"
#include "ui/display/types/gamma_ramp_rgb_entry.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/size.h"
#include "ui/ozone/platform/drm/domicile/drm_screen.h"
#include "ui/ozone/platform/drm/domicile/hdr_output.h"

namespace ui {
namespace {

// Returns `layout`'s entry for connector `id`, or `nullptr` if it has none.
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

}  // namespace

display::GammaCurve GammaCurveOf(const DomicileGammaRamp& ramp) {
  if (ramp.red.empty()) {
    return display::GammaCurve::MakeScale(1.f, 1.f, 1.f);
  }
  std::vector<display::GammaRampRGBEntry> lut;
  lut.reserve(ramp.red.size());
  for (size_t index = 0; index < ramp.red.size(); ++index) {
    lut.push_back({.r = ramp.red[index],
                   .g = ramp.green[index],
                   .b = ramp.blue[index]});
  }
  return display::GammaCurve(std::move(lut));
}

std::unique_ptr<display::DisplaySnapshot> VirtualSnapshot(
    const DomicileVirtualDisplay& display) {
  display::DisplaySnapshot::DisplayModeList modes;
  modes.push_back(std::make_unique<display::DisplayMode>(
      display.mode, /*interlaced=*/false,
      static_cast<float>(display.refresh_mhz) / 1000.f));
  const display::DisplayMode* mode = modes.back().get();
  // No EDID, no physical size and no product code: a TV reached over the
  // network reports none of them to this process.
  std::unique_ptr<display::DisplaySnapshot> snapshot =
      std::make_unique<display::DisplaySnapshot>(
          display.id, display.id, display.id, /*connector_index=*/0u,
          gfx::Point(), /*physical_size=*/gfx::Size(),
          display::DISPLAY_CONNECTION_TYPE_NETWORK, /*base_connector_id=*/0u,
          /*path_topology=*/std::vector<uint64_t>(),
          /*is_aspect_preserving_scaling=*/false, /*has_overscan=*/false,
          display::PrivacyScreenState::kNotSupported,
          /*has_content_protection_key=*/false,
          display::DisplaySnapshot::ColorInfo(), display.name,
          base::FilePath(), std::move(modes),
          display::PanelOrientation::kNormal, /*edid=*/std::vector<uint8_t>(),
          /*current_mode=*/mode, /*native_mode=*/mode, /*product_code=*/0,
          /*year_of_manufacture=*/0, /*maximum_cursor_size=*/gfx::Size(),
          display::VariableRefreshRateState::kVrrNotCapable,
          display::DrmFormatsAndModifiers());
  snapshot->set_domicile_connector(
      base::StrCat({"virtual-",
                    base::NumberToString(
                        display.id & std::numeric_limits<int64_t>::max())}));
  return snapshot;
}

std::vector<display::DisplayConfigurationParams> ModesetParamsFromSnapshots(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& snapshots,
    const std::vector<DomicileDisplayLayout>& layout,
    const base::flat_set<int64_t>& refused) {
  // Shared with the display list so both agree on each display's origin.
  const std::vector<gfx::Point> origins = OriginsForLayout(snapshots, layout);
  std::vector<display::DisplayConfigurationParams> params;
  params.reserve(snapshots.size());
  for (size_t index = 0; index < snapshots.size(); ++index) {
    const display::DisplaySnapshot* snapshot = snapshots[index];
    if (snapshot->type() == display::DISPLAY_CONNECTION_TYPE_NETWORK) {
      // A virtual display. See the header.
      continue;
    }
    const display::DisplayMode* native_mode = snapshot->native_mode();
    if (!native_mode) {
      // No advertised mode, so none is invented. See the header.
      continue;
    }
    const DomicileDisplayLayout* wanted =
        layout.empty() ? nullptr : WantedFor(layout, snapshot->display_id());
    if (!layout.empty() && (!wanted || !wanted->enabled)) {
      // Turned off by the compositor, or not in its layout yet. Asked for with
      // no mode, which turns the CRTC off: left out, it keeps scanning out its
      // last frame.
      params.emplace_back(snapshot->display_id(), origins[index], nullptr);
      continue;
    }
    // Pass the mode borrowed: the params constructor clones it, so cloning
    // here too would leak a DisplayMode per display on every hotplug. The
    // profile's mode if the connector advertises it, as the display list
    // sizes the window; see `ModeForLayout`.
    const bool adaptive_sync = wanted && wanted->adaptive_sync &&
                               snapshot->IsVrrCapable() &&
                               !refused.contains(snapshot->display_id());
    params.emplace_back(snapshot->display_id(), origins[index],
                        ModeForLayout(*snapshot, wanted), adaptive_sync);
    params.back().domicile_hdr = DrivesHdr(*snapshot, wanted);
  }
  return params;
}

base::flat_set<int64_t> AdaptiveSyncAskedIn(
    const std::vector<display::DisplayConfigurationParams>& params) {
  base::flat_set<int64_t> asked;
  for (const display::DisplayConfigurationParams& param : params) {
    if (param.enable_vrr) {
      asked.insert(param.id);
    }
  }
  return asked;
}

std::string DescribeSnapshots(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& snapshots) {
  std::vector<std::string> described;
  described.reserve(snapshots.size());
  for (const display::DisplaySnapshot* snapshot : snapshots) {
    const display::DisplayMode* native_mode = snapshot->native_mode();
    // Whole hertz is precise enough for a log line.
    const std::string mode =
        native_mode
            ? base::StrCat({native_mode->size().ToString(), "@",
                            base::NumberToString(static_cast<int>(
                                native_mode->refresh_rate()))})
            : std::string("no mode");
    described.push_back(base::StrCat({base::NumberToString(
                                          snapshot->display_id()),
                                      " at ", snapshot->origin().ToString(),
                                      " ", mode}));
  }
  return base::StrCat({base::NumberToString(snapshots.size()),
                       " connector(s)", described.empty() ? "" : ": ",
                       base::JoinString(described, "; ")});
}

DrmModeset::DrmModeset(
    std::unique_ptr<display::NativeDisplayDelegate> delegate,
    DrmScreen* screen)
    : delegate_(std::move(delegate)), screen_(screen) {}

DrmModeset::~DrmModeset() {
  delegate_->RemoveObserver(this);
}

void DrmModeset::Start() {
  delegate_->AddObserver(this);
  delegate_->Initialize();
  Read();
}

void DrmModeset::SetLayout(std::vector<DomicileDisplayLayout> layout) {
  VLOG(1) << "domicile: the compositor wants " << layout.size()
          << " connector(s) laid out its way";
  layout_ = std::move(layout);
  // Re-read the displays; see the header.
  Read();
}

void DrmModeset::SetVirtualDisplays(
    std::vector<DomicileVirtualDisplay> displays) {
  VLOG(1) << "domicile: the compositor wants " << displays.size()
          << " virtual display(s)";
  virtual_.clear();
  for (const DomicileVirtualDisplay& display : displays) {
    virtual_.push_back(VirtualSnapshot(display));
  }
  // Re-read the displays; see `SetLayout`.
  Read();
}

void DrmModeset::Relight() {
  // The confirmation from before a resume or VT switch no longer describes
  // the hardware. See the header.
  confirmed_.clear();
  Read();
}

void DrmModeset::Read() {
  if (reading_) {
    read_again_ = true;
    return;
  }
  reading_ = true;
  delegate_->GetDisplays(
      base::BindOnce(&DrmModeset::OnDisplaysReceived, base::Unretained(this)));
}

void DrmModeset::SetGamma(int64_t display_id, DomicileGammaRamp ramp) {
  CHECK_EQ(ramp.red.size(), ramp.green.size());
  CHECK_EQ(ramp.red.size(), ramp.blue.size());
  VLOG(1) << "domicile: the compositor wants display " << display_id
          << " drawn with a " << ramp.red.size() << "-entry gamma ramp";
  if (std::ranges::find(display_ids_, display_id) != display_ids_.end()) {
    ApplyGammaTo(display_id, ramp);
  } else {
    // Applied after the next reading that lists the display. Logged, because
    // a ramp that never arrives looks like no ramp at all.
    LOG(WARNING) << "domicile: display " << display_id
                 << " is not in the last reading of the displays ("
                 << display_ids_.size()
                 << " connector(s)); its gamma ramp waits for the next one";
  }
  ramps_.insert_or_assign(display_id, std::move(ramp));
}

void DrmModeset::ApplyGamma() {
  for (const int64_t id : display_ids_) {
    const auto ramp = ramps_.find(id);
    if (ramp != ramps_.end()) {
      ApplyGammaTo(id, ramp->second);
    }
  }
}

void DrmModeset::ApplyGammaTo(int64_t id, const DomicileGammaRamp& ramp) {
  delegate_->SetGammaAdjustment(id, {.curve = GammaCurveOf(ramp)});
}

void DrmModeset::OnConfigurationChanged() {
  // A hotplug. Re-read so the screen and modeset share one reading.
  Read();
}

void DrmModeset::OnDisplaySnapshotsInvalidated() {
  // `OnDisplaysReceived` keeps no snapshots, but the delegate's display hosts
  // go with them, and a ramp for a display it no longer has reaches nothing.
  display_ids_.clear();
}

std::vector<display::DisplayConfigurationParams> ModesetParamsThatChange(
    const std::vector<display::DisplayConfigurationParams>& asked,
    const std::vector<display::DisplayConfigurationParams>& wanted,
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots) {
  std::vector<display::DisplayConfigurationParams> changed;
  for (const display::DisplayConfigurationParams& one : wanted) {
    const auto snapshot = std::ranges::find(
        snapshots, one.id, &display::DisplaySnapshot::display_id);
    CHECK(snapshot != snapshots.end())
        << "a modeset request for display " << one.id
        << ", which the reading does not have";
    // `operator==` compares every field a modeset request carries.
    if (!std::ranges::contains(asked, one) ||
        (one.mode != nullptr && (*snapshot)->current_mode() == nullptr)) {
      changed.push_back(one);
    }
  }
  return changed;
}

void DrmModeset::OnDisplaysReceived(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& connectors) {
  reading_ = false;
  TakeReading(connectors);
  // A request made while this one was in flight: see `Read`.
  if (std::exchange(read_again_, false)) {
    Read();
  }
}

void DrmModeset::TakeReading(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& connectors) {
  // Log every reading, including its modes. See `DescribeSnapshots`.
  VLOG(1) << "domicile: DRM reports " << DescribeSnapshots(connectors);

  // The virtual displays go after the connectors, so they never take the
  // primary from a lit connector when no layout names one.
  std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>> snapshots =
      connectors;
  for (const std::unique_ptr<display::DisplaySnapshot>& snapshot : virtual_) {
    snapshots.push_back(snapshot.get());
  }

  // Update the screen first: a window needs somewhere to land even if the
  // modeset fails.
  screen_->OnDisplaysChanged(snapshots, layout_);

  // Only connectors have a CRTC, and so a ramp.
  display_ids_.clear();
  for (const display::DisplaySnapshot* snapshot : connectors) {
    display_ids_.push_back(snapshot->display_id());
  }
  // A monitor unplugged since its adaptive sync was refused may come back on
  // another port or driver, so it is asked again.
  base::EraseIf(adaptive_sync_refused_, [this](int64_t id) {
    return std::ranges::find(display_ids_, id) == display_ids_.end();
  });

  std::vector<display::DisplayConfigurationParams> params =
      ModesetParamsFromSnapshots(snapshots, layout_, adaptive_sync_refused_);
  if (params.empty()) {
    // Not an error: a machine with no panel reports this.
    VLOG(1) << "domicile: nothing readable is plugged in; not modesetting";
    return;
  }

  std::vector<display::DisplayConfigurationParams> changed =
      ModesetParamsThatChange(confirmed_, params, snapshots);
  if (changed.empty()) {
    // The CRTCs already match. This is usually the udev CHANGE from our own
    // last modeset, or a display unplugged.
    VLOG(1) << "domicile: the displays read the same as last time; not "
               "modesetting again";
    confirmed_ = std::move(params);
    // A ramp sent while the displays were unread is applied here, with no
    // modeset to apply it after.
    ApplyGamma();
    return;
  }

  VLOG(1) << "domicile: configuring " << changed.size() << " display(s)";
  inside_configure_ = true;
  // Only a request that differs can have brought adaptive sync into this
  // modeset. A display asked for again only because it reads dark, as one
  // another session left dark does, keeps its adaptive sync when refused.
  std::vector<display::DisplayConfigurationParams> requested;
  for (const display::DisplayConfigurationParams& one : changed) {
    if (!std::ranges::contains(confirmed_, one)) {
      requested.push_back(one);
    }
  }
  delegate_->Configure(
      changed,
      base::BindOnce(
          [](base::WeakPtr<DrmModeset> self,
             std::vector<display::DisplayConfigurationParams> asked,
             std::vector<display::DisplayConfigurationParams> requested,
             const std::vector<display::DisplayConfigurationParams>&,
             bool status) {
            if (!self) {
              return;
            }
            const base::flat_set<int64_t> adaptive_sync =
                AdaptiveSyncAskedIn(requested);
            if (!status && !adaptive_sync.empty() &&
                !self->inside_configure_) {
              // Adaptive sync may be what the driver refused, so ask again
              // without it, as sway does. The reading after reports it off.
              // Not for an answer from inside `Configure`, which no hardware
              // gave; see below.
              LOG(WARNING) << "domicile: the DRM thread refused a modeset "
                              "with adaptive sync on "
                           << adaptive_sync.size()
                           << " display(s); trying again without it";
              self->adaptive_sync_refused_.insert(adaptive_sync.begin(),
                                                  adaptive_sync.end());
              self->Read();
              return;
            }
            if (!status) {
              // Not recorded: only a confirmed modeset is compared against.
              // See `ModesetParamsThatChange`.
              LOG(ERROR) << "domicile: the DRM thread refused the modeset; the "
                            "displays it reported are connected but nothing is "
                            "lit";
              return;
            }
            if (self->inside_configure_) {
              // Answered before `Configure` returned, so no hardware saw it.
              // `Start()` runs before the GPU process exists, and
              // `DrmDisplayHostManager` answers from its dummy snapshots
              // synchronously. Recording this would make the first real
              // reading look like a repeat, so a machine whose dummy reading
              // matches its real one would never modeset.
              VLOG(1) << "domicile: the modeset was answered from inside the "
                         "browser process; no hardware saw it, so it is not a "
                         "confirmation";
              return;
            }
            VLOG(1) << "domicile: the DRM thread confirmed the modeset";
            const bool adaptive_sync_changed =
                AdaptiveSyncAskedIn(asked) !=
                AdaptiveSyncAskedIn(self->confirmed_);
            self->confirmed_ = std::move(asked);
            self->ApplyGamma();
            if (adaptive_sync_changed) {
              // A snapshot reads adaptive sync off the CRTC, so the reading
              // that went with this modeset predates it. Read again so the
              // display list says whether it took; the modeset it would ask
              // for is this one, so it asks for none.
              self->Read();
            }
          },
          weak_factory_.GetWeakPtr(), std::move(params), std::move(requested)),
      {display::ModesetFlag::kCommitModeset});
  inside_configure_ = false;
}

}  // namespace ui
