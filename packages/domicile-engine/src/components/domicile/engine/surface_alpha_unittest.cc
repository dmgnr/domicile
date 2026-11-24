// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_alpha.h"

#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// The fourccs the engine imports. Keep in sync with FormatFromFourcc in
// brokered_frame_sink.cc and FOURCCS in the compositor's engine.rs.
constexpr uint32_t kArgb8888 = 0x34325241;
constexpr uint32_t kXrgb8888 = 0x34325258;
constexpr uint32_t kAbgr8888 = 0x34324241;
constexpr uint32_t kXbgr8888 = 0x34324258;
constexpr uint32_t kArgb2101010 = 0x30335241;
constexpr uint32_t kXrgb2101010 = 0x30335258;
constexpr uint32_t kAbgr2101010 = 0x30334241;
constexpr uint32_t kXbgr2101010 = 0x30334258;
constexpr uint32_t kAbgr16161616f = 0x48344241;
constexpr uint32_t kXbgr16161616f = 0x48344258;

// Drawn opaque, a menu's transparent rounded corners would render black.
TEST(SurfaceAlphaTest, ABufferWithAlphaIsBlended) {
  EXPECT_TRUE(FourccHasAlpha(kArgb8888));
  EXPECT_TRUE(FourccHasAlpha(kAbgr8888));
  EXPECT_TRUE(FourccHasAlpha(kArgb2101010));
  EXPECT_TRUE(FourccHasAlpha(kAbgr2101010));
  EXPECT_TRUE(FourccHasAlpha(kAbgr16161616f));
}

TEST(SurfaceAlphaTest, ABufferWithoutAlphaIsOpaque) {
  EXPECT_FALSE(FourccHasAlpha(kXrgb8888));
  EXPECT_FALSE(FourccHasAlpha(kXbgr8888));
  EXPECT_FALSE(FourccHasAlpha(kXrgb2101010));
  EXPECT_FALSE(FourccHasAlpha(kXbgr2101010));
  EXPECT_FALSE(FourccHasAlpha(kXbgr16161616f));
}

}  // namespace
}  // namespace domicile
