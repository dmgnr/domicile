// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/hdr_output.h"

#include <algorithm>

#include "ui/display/types/display_snapshot.h"
#include "ui/gfx/color_space.h"
#include "ui/gfx/hdr_static_metadata.h"
#include "ui/ozone/platform/drm/domicile/ten_bit_scanout.h"

namespace ui {

bool TakesHdr(const display::DisplaySnapshot& snapshot) {
  const std::optional<gfx::HDRStaticMetadata>& metadata =
      snapshot.hdr_static_metadata();
  return metadata.has_value() &&
         metadata->IsEotfSupported(gfx::HDRStaticMetadata::Eotf::kPq) &&
         TenBitScanoutFourcc(snapshot).has_value();
}

bool DrivesHdr(const display::DisplaySnapshot& snapshot,
               const DomicileDisplayLayout* wanted) {
  return wanted && wanted->enabled && wanted->hdr && TakesHdr(snapshot);
}

DomicileHdr HdrOf(const display::DisplaySnapshot& snapshot,
                  const DomicileDisplayLayout* wanted) {
  if (!TakesHdr(snapshot)) {
    return DomicileHdr::kUnsupported;
  }
  return DrivesHdr(snapshot, wanted) ? DomicileHdr::kOn : DomicileHdr::kOff;
}

gfx::DisplayColorSpaces HdrColorSpaces(
    const display::DisplaySnapshot& snapshot,
    float sdr_white_nits,
    viz::SharedImageFormat format) {
  gfx::DisplayColorSpaces color_spaces(gfx::ColorSpace::CreateHDR10(),
                                       format);
  const std::optional<gfx::HDRStaticMetadata>& metadata =
      snapshot.hdr_static_metadata();
  const float peak = metadata.has_value() && metadata->max > 0
                         ? static_cast<float>(metadata->max)
                         : kUnreportedPeakNits;
  color_spaces.SetSDRMaxLuminanceNits(sdr_white_nits);
  // No headroom below SDR white: a white brighter than the panel's peak
  // still shows at the peak.
  color_spaces.SetHDRMaxLuminanceRelative(
      std::max(1.f, peak / sdr_white_nits));
  return color_spaces;
}

}  // namespace ui
