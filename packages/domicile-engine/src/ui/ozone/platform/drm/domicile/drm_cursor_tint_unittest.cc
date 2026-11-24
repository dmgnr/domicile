// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_cursor_tint.h"

#include <array>
#include <vector>

#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"

namespace ui {
namespace {

SkBitmap Filled(SkColor color) {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(2, 2);
  bitmap.eraseColor(color);
  return bitmap;
}

// A night light's linear gains for a ramp that halves green and quarters
// blue, as the compositor sends them.
constexpr std::array<float, 3> kWarm = {1.f, 0.2176376f, 0.0473661f};

TEST(DrmCursorTintTest, AWhitePointerIsWarmedAsARampWouldWarmIt) {
  const std::vector<SkBitmap> tinted =
      TintedCursorBitmaps({Filled(SK_ColorWHITE)}, kWarm);

  ASSERT_EQ(tinted.size(), 1u);
  const SkColor color = tinted[0].getColor(1, 1);
  EXPECT_EQ(SkColorGetA(color), 255u);
  EXPECT_EQ(SkColorGetR(color), 255u);
  EXPECT_NEAR(SkColorGetG(color), 128, 1);
  EXPECT_NEAR(SkColorGetB(color), 64, 1);
}

TEST(DrmCursorTintTest, ClearPixelsStayClear) {
  const std::vector<SkBitmap> tinted =
      TintedCursorBitmaps({Filled(SK_ColorTRANSPARENT)}, kWarm);

  EXPECT_EQ(SkColorGetA(tinted[0].getColor(0, 0)), 0u);
}

TEST(DrmCursorTintTest, EveryFrameOfAnAnimatedPointerIsWarmed) {
  const std::vector<SkBitmap> tinted = TintedCursorBitmaps(
      {Filled(SK_ColorWHITE), Filled(SK_ColorWHITE)}, kWarm);

  ASSERT_EQ(tinted.size(), 2u);
  EXPECT_NEAR(SkColorGetB(tinted[1].getColor(0, 0)), 64, 1);
}

TEST(DrmCursorTintTest, UntintedGainsDrawThePointerAsItIs) {
  const std::vector<SkBitmap> tinted =
      TintedCursorBitmaps({Filled(SkColorSetRGB(10, 200, 90))}, kUntinted);

  EXPECT_EQ(tinted[0].getColor(0, 0), SkColorSetRGB(10, 200, 90));
}

}  // namespace
}  // namespace ui
