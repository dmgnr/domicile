// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/buffer_color.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/private/SkHdrMetadata.h"

namespace domicile {
namespace {

using PrimaryID = gfx::ColorSpace::PrimaryID;
using TransferID = gfx::ColorSpace::TransferID;

DomicileColor Described(DomicilePrimaries primaries,
                        DomicileTransfer transfer) {
  DomicileColor color = {};
  color.primaries = primaries;
  color.transfer = transfer;
  return color;
}

TEST(BufferColorTest, EachNamedColorIsItsColorSpace) {
  const struct {
    DomicilePrimaries primaries;
    DomicileTransfer transfer;
    gfx::ColorSpace expected;
  } kCases[] = {
      {DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_SRGB,
       gfx::ColorSpace::CreateSRGB()},
      {DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_GAMMA22,
       gfx::ColorSpace(PrimaryID::BT709, TransferID::GAMMA22)},
      {DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_BT1886,
       gfx::ColorSpace(PrimaryID::BT709, TransferID::GAMMA24)},
      {DOMICILE_PRIMARIES_DISPLAY_P3, DOMICILE_TRANSFER_SRGB,
       gfx::ColorSpace::CreateDisplayP3D65()},
      {DOMICILE_PRIMARIES_ADOBE_RGB, DOMICILE_TRANSFER_GAMMA22,
       gfx::ColorSpace(PrimaryID::ADOBE_RGB, TransferID::GAMMA22)},
      {DOMICILE_PRIMARIES_BT2020, DOMICILE_TRANSFER_PQ,
       gfx::ColorSpace(PrimaryID::BT2020, TransferID::PQ)},
      {DOMICILE_PRIMARIES_BT2020, DOMICILE_TRANSFER_HLG,
       gfx::ColorSpace(PrimaryID::BT2020, TransferID::HLG)},
      {DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_EXT_LINEAR,
       gfx::ColorSpace(PrimaryID::BT709, TransferID::LINEAR_HDR)},
      {DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_SCRGB,
       gfx::ColorSpace(PrimaryID::BT709, TransferID::SCRGB_LINEAR_80_NITS)},
  };
  for (const auto& each : kCases) {
    SCOPED_TRACE(each.expected.ToString());
    const BufferColor color =
        BufferColorFrom(Described(each.primaries, each.transfer));
    EXPECT_EQ(color.color_space, each.expected);
    EXPECT_TRUE(color.hdr_metadata.IsEmpty());
  }
}

TEST(BufferColorTest, AnUnknownNameIsSrgb) {
  EXPECT_EQ(BufferColorFrom(Described(99, 99)).color_space,
            gfx::ColorSpace::CreateSRGB());
}

TEST(BufferColorTest, HdrContentCarriesItsMetadata) {
  DomicileColor described =
      Described(DOMICILE_PRIMARIES_BT2020, DOMICILE_TRANSFER_PQ);
  described.has_mastering = 1;
  described.mastering_red = {0.68f, 0.32f};
  described.mastering_green = {0.265f, 0.69f};
  described.mastering_blue = {0.15f, 0.06f};
  described.mastering_white = {0.3127f, 0.329f};
  described.mastering_min_luminance = 0.005f;
  described.mastering_max_luminance = 1000.f;
  described.max_cll = 800.f;
  described.max_fall = 400.f;

  const gfx::HDRMetadata metadata = BufferColorFrom(described).hdr_metadata;

  ASSERT_TRUE(metadata.HasMDCV());
  EXPECT_FLOAT_EQ(metadata.GetMDCV().fDisplayPrimaries.fRX, 0.68f);
  EXPECT_FLOAT_EQ(metadata.GetMDCV().fDisplayPrimaries.fWY, 0.329f);
  EXPECT_FLOAT_EQ(metadata.GetMDCV().fMaximumDisplayMasteringLuminance, 1000.f);
  EXPECT_FLOAT_EQ(metadata.GetMDCV().fMinimumDisplayMasteringLuminance, 0.005f);
  ASSERT_TRUE(metadata.HasCLLI());
  EXPECT_FLOAT_EQ(metadata.GetCLLI().fMaxCLL, 800.f);
  EXPECT_FLOAT_EQ(metadata.GetCLLI().fMaxFALL, 400.f);
}

TEST(BufferColorTest, OnlyHdrContentPlacesItsReferenceWhite) {
  DomicileColor pq = Described(DOMICILE_PRIMARIES_BT2020, DOMICILE_TRANSFER_PQ);
  pq.reference_luminance = 300.f;
  const gfx::HDRMetadata hdr = BufferColorFrom(pq).hdr_metadata;
  ASSERT_TRUE(hdr.HasAgtm());
  EXPECT_FLOAT_EQ(hdr.GetAgtm().fHdrReferenceWhite, 300.f);

  DomicileColor srgb =
      Described(DOMICILE_PRIMARIES_SRGB, DOMICILE_TRANSFER_SRGB);
  srgb.reference_luminance = 300.f;
  EXPECT_TRUE(BufferColorFrom(srgb).hdr_metadata.IsEmpty());
}

}  // namespace
}  // namespace domicile
