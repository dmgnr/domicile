// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_DISPLAY_LIST_H_
#define COMPONENTS_DOMICILE_BROWSER_DISPLAY_LIST_H_

#include <stdint.h>

#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "components/domicile/mojom/frame_sink_broker.mojom.h"
#include "ui/display/display.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {

// A mode a connector advertises.
struct DisplayPanelMode {
  gfx::Size size;
  int32_t refresh_mhz = 0;
};

// What `ui::OzonePlatform::GetDomicilePanels` says of one display, which
// //content copies here because this target cannot depend on //ui/ozone.
struct DisplayPanel {
  std::vector<DisplayPanelMode> modes;
  // The rate of the mode it scans out, in mHz.
  int32_t refresh_mhz = 0;
  // Empty when unreported.
  gfx::Size physical_size_mm;
  // Whether it scans out with a variable refresh rate.
  mojom::AdaptiveSync adaptive_sync = mojom::AdaptiveSync::kUnsupported;
  // Whether it is driven in HDR10, and its luminances in cd/m².
  mojom::Hdr hdr = mojom::Hdr::kUnsupported;
  float max_luminance = 0.f;
  float max_average_luminance = 0.f;
  float min_luminance = 0.f;
  float sdr_white_nits = 0.f;
};

// Converts ozone's displays into the list the compositor advertises as
// wl_output.
//
// Converts to wl_output units: millimeters instead of density, and mHz instead
// of Hz. The name is the `label` that
// ui/ozone/platform/drm/domicile/drm_screen.cc built from the panel's EDID.
//
// `connectors` names each display's connector by id, as
// `ui::OzonePlatform::GetDomicileConnectors` gives them. A display it does not
// name, as on a platform with no connectors, crosses with none.
//
// `gamma_sizes` is each display's gamma ramp size, as
// `ui::OzonePlatform::GetDomicileGammaSizes` gives them. A display it does not
// name crosses with 0: no gamma.
//
// `panels` is each display's advertised modes, the rate it scans out at and
// its millimeters. Where it names a display, its rate and millimeters win
// over the display's own: `display::DisplayList` keeps the first ones it
// lists, so a mode change on the same monitor would cross stale. A display
// it does not name crosses with no modes, no adaptive sync and no HDR.
std::vector<mojom::DisplayPtr> DisplayListFor(
    const std::vector<display::Display>& displays,
    const base::flat_map<int64_t, std::string>& connectors,
    const base::flat_map<int64_t, uint32_t>& gamma_sizes,
    const base::flat_map<int64_t, DisplayPanel>& panels);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_DISPLAY_LIST_H_
