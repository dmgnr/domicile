// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_TINT_H_
#define UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_TINT_H_

#include <array>
#include <vector>

#include "third_party/skia/include/core/SkBitmap.h"

namespace ui {

// Gains that draw the pointer as it is.
inline constexpr std::array<float, 3> kUntinted = {1.f, 1.f, 1.f};

// `bitmaps` warmed by the night light's `gains`: red, green and blue, 0 to 1,
// in linear light.
//
// - On a display whose CRTC has no gamma (a DisplayLink dock) viz warms the
//   frame through a color matrix, and the cursor plane skips it. A white
//   pointer on that warm screen looks blue, so its image is warmed instead.
// - Each encoded channel is scaled by its gain's 2.2nd root: what a CRTC's
//   ramp does to the pointer on every other monitor. Alpha is kept.
std::vector<SkBitmap> TintedCursorBitmaps(const std::vector<SkBitmap>& bitmaps,
                                          const std::array<float, 3>& gains);

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_DRM_DOMICILE_DRM_CURSOR_TINT_H_
