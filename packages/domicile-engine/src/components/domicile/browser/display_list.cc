// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/display_list.h"

#include <string>
#include <utility>
#include <vector>

#include "base/numerics/safe_conversions.h"
#include "ui/display/types/display_constants.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {
namespace {

// wl_output reports refresh rates in mHz.
constexpr float kMillihertzPerHertz = 1000.f;

// Recovers a display's physical size in millimeters from its density.
//
// Inverts drm_screen.cc with the same display::kInchInMm so the result is
// exact. Computed per axis because pixels need not be square. Uses pixels, not
// bounds(), because density is per pixel. Zero density means unknown and maps
// to an empty size, which wl_output also reads as unknown.
gfx::Size PhysicalSizeMm(const display::Display& screen) {
  const float horizontal = screen.GetPixelsPerInchX();
  const float vertical = screen.GetPixelsPerInchY();
  if (horizontal <= 0.f || vertical <= 0.f) {
    return gfx::Size();
  }
  const gfx::Size pixels = screen.GetSizeInPixel();
  return gfx::Size(
      base::ClampRound(display::kInchInMm * pixels.width() / horizontal),
      base::ClampRound(display::kInchInMm * pixels.height() / vertical));
}

}  // namespace

std::vector<mojom::DisplayPtr> DisplayListFor(
    const std::vector<display::Display>& displays,
    const base::flat_map<int64_t, std::string>& connectors,
    const base::flat_map<int64_t, uint32_t>& gamma_sizes,
    const base::flat_map<int64_t, DisplayPanel>& panels) {
  std::vector<mojom::DisplayPtr> list;
  list.reserve(displays.size());
  // Not named `display`, which would shadow the namespace.
  for (const display::Display& screen : displays) {
    const auto connector = connectors.find(screen.id());
    const auto gamma_size = gamma_sizes.find(screen.id());
    const auto panel = panels.find(screen.id());
    int32_t refresh_mhz =
        base::ClampRound(screen.display_frequency() * kMillihertzPerHertz);
    gfx::Size physical_size_mm = PhysicalSizeMm(screen);
    std::vector<mojom::DisplayModePtr> modes;
    mojom::AdaptiveSync adaptive_sync = mojom::AdaptiveSync::kUnsupported;
    const DisplayPanel unpaneled;
    const DisplayPanel& hdr =
        panel != panels.end() ? panel->second : unpaneled;
    if (panel != panels.end()) {
      refresh_mhz = panel->second.refresh_mhz;
      adaptive_sync = panel->second.adaptive_sync;
      physical_size_mm = panel->second.physical_size_mm;
      modes.reserve(panel->second.modes.size());
      for (const DisplayPanelMode& mode : panel->second.modes) {
        modes.push_back(mojom::DisplayMode::New(mode.size, mode.refresh_mhz));
      }
    }
    list.push_back(mojom::Display::New(
        screen.id(), screen.bounds(), physical_size_mm, screen.label(),
        refresh_mhz,
        connector == connectors.end() ? std::string() : connector->second,
        gamma_size == gamma_sizes.end() ? 0u : gamma_size->second,
        std::move(modes), adaptive_sync, hdr.hdr, hdr.max_luminance,
        hdr.max_average_luminance, hdr.min_luminance, hdr.sdr_white_nits));
  }
  return list;
}

}  // namespace domicile
