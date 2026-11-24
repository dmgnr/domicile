// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_HDR_OUTPUT_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_HDR_OUTPUT_H_

#include "components/viz/common/resources/shared_image_format.h"
#include "ui/gfx/display_color_spaces.h"
#include "ui/ozone/public/ozone_platform.h"

namespace display {
class DisplaySnapshot;
}  // namespace display

namespace ui {

// The peak luminance a panel that reports none is taken to reach, in cd/m².
inline constexpr float kUnreportedPeakNits = 1000.f;

// Whether `snapshot`'s panel can be driven in HDR10: its EDID's HDR static
// metadata takes PQ, and it scans out in 10 bits (`TenBitScanoutFourcc`).
bool TakesHdr(const display::DisplaySnapshot& snapshot);

// Whether `snapshot` is driven in HDR10: `wanted` asks for it and the panel
// takes it. The modeset asks the GPU process for it (drm_modeset.cc) and the
// browser draws in it (drm_screen.cc) on this one answer, so they agree.
bool DrivesHdr(const display::DisplaySnapshot& snapshot,
               const DomicileDisplayLayout* wanted);

// What the panel reports for the compositor: whether it is driven in HDR10.
DomicileHdr HdrOf(const display::DisplaySnapshot& snapshot,
                  const DomicileDisplayLayout* wanted);

// The color spaces viz draws an HDR10 display in: BT.2020 with PQ in
// `format`, SDR content's white at `sdr_white_nits`, and headroom up to the
// panel's peak from its EDID.
gfx::DisplayColorSpaces HdrColorSpaces(
    const display::DisplaySnapshot& snapshot,
    float sdr_white_nits,
    viz::SharedImageFormat format);

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_HDR_OUTPUT_H_
