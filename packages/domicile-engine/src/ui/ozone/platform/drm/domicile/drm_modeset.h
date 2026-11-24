// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_MODESET_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_MODESET_H_

#include <memory>
#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "ui/display/types/display_color_management.h"
#include "ui/display/types/display_configuration_params.h"
#include "ui/display/types/native_display_delegate.h"
#include "ui/display/types/native_display_observer.h"
#include "ui/ozone/public/ozone_platform.h"

namespace display {
class DisplaySnapshot;
}

namespace ui {

class DrmScreen;

// Returns a snapshot of `display` to read beside the connectors: a
// `DISPLAY_CONNECTION_TYPE_NETWORK` display at its mode, named `display.name`,
// on connector "virtual-<n>", where n is the id without its top bit. The
// compositor names the display from n, so n must not change while it lives.
//
// A cast extends the desk onto it. The browser lays it out and draws it like a
// connector; only a capture shows it. See
// docs/CASTING-TO-TVS.md in the Domicile repository.
std::unique_ptr<display::DisplaySnapshot> VirtualSnapshot(
    const DomicileVirtualDisplay& display);

// The curve a CRTC draws `ramp` with. Empty channels are an identity ramp,
// not an empty curve: an empty curve leaves the CRTC's last ramp on it, so a
// night light never turned off.
display::GammaCurve GammaCurveOf(const DomicileGammaRamp& ramp);

// Builds the modeset request for the connected displays. A free function so
// it can be unit tested.
//
// A virtual display is skipped: no CRTC drives it.
//
// A snapshot with no native mode is skipped. `DisplaysFromSnapshots` gives one
// a fallback because a window must land somewhere, but a modeset must not ask
// a CRTC for a mode the hardware never advertised.
//
// `layout` is the compositor's display config, which arrives over the
// engine's C ABI because this process holds DRM master. When it is empty,
// every readable connector lights, placed by `OriginsForLayout`. When it is
// not, a connector it turns off or does not name is asked for with no mode,
// which turns its CRTC off; a newly plugged monitor lights once the compositor
// answers the hotplug this modeset triggers. An idle blank turns every
// connector off this way. See docs/DISPLAYS.md#which-connectors-light.
//
// A lit connector is asked for adaptive sync when its layout entry wants it,
// its snapshot says it can, and `refused` does not name it: a modeset asking
// for it there was refused, as sway retries without it. See
// docs/DISPLAYS.md#adaptive-sync.
std::vector<display::DisplayConfigurationParams> ModesetParamsFromSnapshots(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& snapshots,
    const std::vector<DomicileDisplayLayout>& layout,
    const base::flat_set<int64_t>& refused = {});

// The displays `params` asks for adaptive sync on.
base::flat_set<int64_t> AdaptiveSyncAskedIn(
    const std::vector<display::DisplayConfigurationParams>& params);

// Describes a display reading in one log line, including each native mode.
//
// The mode matters because the browser window must match it exactly
// (`ScreenManager::FindWindowAt` compares whole rectangles); otherwise every
// page flip is dropped. Chromium's own modeset logging needs
// `--vmodule=screen_manager=1`; see docs/TTY-DEBUGGING.md#seeing-a-modeset.
std::string DescribeSnapshots(
    const std::vector<raw_ptr<display::DisplaySnapshot,
                              DanglingUntriaged>>& snapshots);

// The requests in `wanted` that differ from the last confirmed modeset,
// `asked`, or that light a display whose CRTC `snapshots` read as dark. Empty
// when nothing changed.
//
// A display left out keeps scanning out as it is. Asking for it again points
// its plane at a new modeset buffer, which is black when the driver tiles its
// framebuffers (i915), so an unchanged display flashes.
//
// A display that reads dark is asked for even if its request is unchanged:
// a hotplug can move it to a CRTC nothing has lit. One moved onto a CRTC still
// lit at the same timings, for a connector unplugged or moved away, reads lit
// and is missed.
//
// Each `Configure` makes the kernel emit a udev CHANGE, which triggers another
// reading. Asking for nothing when the request matches the last confirmed one
// stops that loop. A real hotplug changes the reading and gets through.
//
// Compare only against confirmed modesets. The first `Configure` goes out
// before the GPU process has a DRM device, so it reaches nothing; recording it
// would suppress the identical reading that later does work.
std::vector<display::DisplayConfigurationParams> ModesetParamsThatChange(
    const std::vector<display::DisplayConfigurationParams>& asked,
    const std::vector<display::DisplayConfigurationParams>& wanted,
    const std::vector<raw_ptr<display::DisplaySnapshot, DanglingUntriaged>>&
        snapshots);

// Drives `NativeDisplayDelegate` to modeset off ChromeOS, where
// `DisplayConfigurator` is unavailable. See
// docs/architecture/A-DESKTOP-ON-A-TTY.md#the-modeset-driver.
//
// It passes `DrmScreen` the same snapshots it modesets from, so the display
// list and the lit CRTCs come from one reading.
class DrmModeset : public display::NativeDisplayObserver {
 public:
  DrmModeset(std::unique_ptr<display::NativeDisplayDelegate> delegate,
             DrmScreen* screen);

  DrmModeset(const DrmModeset&) = delete;
  DrmModeset& operator=(const DrmModeset&) = delete;

  ~DrmModeset() override;

  // Initializes the delegate and requests the displays. Modesets when they
  // arrive and on every hotplug.
  void Start();

  // Sets the compositor's display layout; see `ModesetParamsFromSnapshots`.
  //
  // Re-reads the displays because no snapshots are held between callbacks,
  // and the screen and the modeset must come from one reading.
  void SetLayout(std::vector<DomicileDisplayLayout> layout);

  // Sets the virtual displays, replacing the last list. Each joins every
  // reading after the connectors; see `VirtualSnapshot`. Re-reads, as
  // `SetLayout` does.
  void SetVirtualDisplays(std::vector<DomicileVirtualDisplay> displays);

  // Modesets again even if the reading is unchanged.
  //
  // After a resume or a VT switch back, the CRTCs are reset or programmed by
  // another process, but the connectors report the same as before, so
  // `ModesetParamsThatChange` would skip the modeset. This clears the last
  // confirmation so the next reading gets through. Called by `DrmSleep` and
  // `DrmVtSwitcher`.
  void Relight();

  // Sets the gamma ramp display `display_id` draws with, for a night light or
  // a gamma-control client. Empty channels draw colors as they are. Kept per
  // display and set again after each confirmed modeset, since a resume or a
  // console switch back can leave another process's ramp on the CRTCs.
  void SetGamma(int64_t display_id, DomicileGammaRamp ramp);

  // display::NativeDisplayObserver:
  void OnConfigurationChanged() override;
  void OnDisplaySnapshotsInvalidated() override;

 private:
  // Asks the delegate for the displays, one reading at a time.
  //
  // `DrmDisplayHostManager` keeps one pending `GetDisplays` callback: a second
  // request before the GPU answers replaces the first and sends another
  // refresh. The answer without a callback still invalidates the snapshots,
  // which empties `display_ids_` with nothing to fill it, and every ramp after
  // that was stored and never applied. So a request made while a reading is in
  // flight is remembered, and made once that reading arrives.
  void Read();
  void OnDisplaysReceived(
      const std::vector<raw_ptr<display::DisplaySnapshot,
                                DanglingUntriaged>>& snapshots);
  // What one reading does: lays the screen out, notes the connectors, applies
  // their ramps and modesets if anything changed.
  void TakeReading(
      const std::vector<raw_ptr<display::DisplaySnapshot,
                                DanglingUntriaged>>& snapshots);
  // Sends each display in `display_ids_` its ramp in `ramps_`, if it has one.
  void ApplyGamma();
  // Sends display `id` its ramp.
  void ApplyGammaTo(int64_t id, const DomicileGammaRamp& ramp);

  const std::unique_ptr<display::NativeDisplayDelegate> delegate_;
  const raw_ptr<DrmScreen> screen_;  // Not owned; outlives this.
  // The last modeset the hardware confirmed. See
  // `ModesetParamsThatChange`.
  std::vector<display::DisplayConfigurationParams> confirmed_;
  // The connectors a refused modeset asked for adaptive sync on. Not asked
  // for it again until unplugged; see `ModesetParamsFromSnapshots`.
  base::flat_set<int64_t> adaptive_sync_refused_;
  // The compositor's last layout; empty until it sends one.
  std::vector<DomicileDisplayLayout> layout_;
  // The compositor's virtual displays, as snapshots. See `VirtualSnapshot`.
  std::vector<std::unique_ptr<display::DisplaySnapshot>> virtual_;
  // The connectors of the last reading. Emptied when their snapshots are
  // invalidated, because the delegate's hosts for them go too.
  std::vector<int64_t> display_ids_;
  // The compositor's last ramp for each display. A display it has sent none
  // for keeps the ramp it has.
  base::flat_map<int64_t, DomicileGammaRamp> ramps_;
  // Whether `delegate_->Configure` is still running. A real modeset is
  // answered on a later task, so an answer that arrives while this is true
  // came from this process, not the hardware. See `OnDisplaysReceived`.
  bool inside_configure_ = false;
  // Whether a `GetDisplays` is waiting for its answer, and whether another
  // was asked for meanwhile. See `Read`.
  bool reading_ = false;
  bool read_again_ = false;
  base::WeakPtrFactory<DrmModeset> weak_factory_{this};
};

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_MODESET_H_
