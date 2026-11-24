// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_cursor_tint.h"

#include <cmath>
#include <ostream>

#include "base/check.h"
#include "third_party/skia/include/core/SkBlendMode.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkColorFilter.h"
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "third_party/skia/include/core/SkSamplingOptions.h"
#include "third_party/skia/include/effects/SkColorMatrix.h"

namespace ui {

std::vector<SkBitmap> TintedCursorBitmaps(const std::vector<SkBitmap>& bitmaps,
                                          const std::array<float, 3>& gains) {
  // The ramp's gain is the light's to the 1/2.2: see `Ramps::matrix` in
  // domicile-compositor/src/gamma.rs.
  const auto encoded = [](float gain) { return std::pow(gain, 1.f / 2.2f); };
  SkColorMatrix scale;
  scale.setScale(encoded(gains[0]), encoded(gains[1]), encoded(gains[2]), 1.f);
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  paint.setColorFilter(SkColorFilters::Matrix(scale));

  std::vector<SkBitmap> tinted;
  tinted.reserve(bitmaps.size());
  for (const SkBitmap& bitmap : bitmaps) {
    SkBitmap warm;
    CHECK(warm.tryAllocPixels(bitmap.info()))
        << "domicile: no memory for a " << bitmap.width() << "x"
        << bitmap.height() << " pointer";
    warm.eraseColor(SK_ColorTRANSPARENT);
    SkCanvas(warm).drawImage(bitmap.asImage(), 0, 0, SkSamplingOptions(),
                             &paint);
    tinted.push_back(std::move(warm));
  }
  return tinted;
}

}  // namespace ui
