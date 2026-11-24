// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_TEN_BIT_SCANOUT_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_TEN_BIT_SCANOUT_H_

#include <cstdint>
#include <optional>

namespace display {
class DisplaySnapshot;
}  // namespace display

namespace ui {

// The 10-bit DRM format to scan `snapshot` out in: XBGR2101010 where its
// planes take it, else XRGB2101010. None when its EDID reports fewer than 10
// bits a channel or its planes take neither, so it scans out in 8 bits.
//
// The browser draws the display's frames in the matching viz format
// (drm_screen.cc), and the GPU process asks its connector for 10 bits a
// channel (drm_display.cc). See docs/architecture/COLOR.md in the Domicile
// repository.
std::optional<uint32_t> TenBitScanoutFourcc(
    const display::DisplaySnapshot& snapshot);

// The `max bpc` the connector is asked for when it scans out in 10 bits.
inline constexpr uint64_t kTenBitsPerChannel = 10;

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_TEN_BIT_SCANOUT_H_
