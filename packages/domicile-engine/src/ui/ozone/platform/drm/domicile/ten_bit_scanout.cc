// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/ten_bit_scanout.h"

#include <drm_fourcc.h>

#include "ui/display/types/display_snapshot.h"

namespace ui {

std::optional<uint32_t> TenBitScanoutFourcc(
    const display::DisplaySnapshot& snapshot) {
  if (snapshot.bits_per_channel() < 10) {
    return std::nullopt;
  }
  const display::DrmFormatsAndModifiers& formats =
      snapshot.GetDRMFormatsAndModifiers();
  for (const uint32_t fourcc : {DRM_FORMAT_XBGR2101010, DRM_FORMAT_XRGB2101010}) {
    if (formats.contains(fourcc)) {
      return fourcc;
    }
  }
  return std::nullopt;
}

}  // namespace ui
