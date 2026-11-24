// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/buffer_color.h"

#include "third_party/skia/include/core/SkColorSpace.h"
#include "third_party/skia/include/private/SkHdrMetadata.h"

namespace domicile {

namespace {

gfx::ColorSpace::PrimaryID PrimariesFrom(DomicilePrimaries primaries) {
  switch (primaries) {
    case DOMICILE_PRIMARIES_BT2020:
      return gfx::ColorSpace::PrimaryID::BT2020;
    case DOMICILE_PRIMARIES_DISPLAY_P3:
      return gfx::ColorSpace::PrimaryID::P3;
    case DOMICILE_PRIMARIES_ADOBE_RGB:
      return gfx::ColorSpace::PrimaryID::ADOBE_RGB;
    default:
      return gfx::ColorSpace::PrimaryID::BT709;
  }
}

gfx::ColorSpace::TransferID TransferFrom(DomicileTransfer transfer) {
  switch (transfer) {
    case DOMICILE_TRANSFER_GAMMA22:
      return gfx::ColorSpace::TransferID::GAMMA22;
    case DOMICILE_TRANSFER_BT1886:
      return gfx::ColorSpace::TransferID::GAMMA24;
    case DOMICILE_TRANSFER_EXT_LINEAR:
      return gfx::ColorSpace::TransferID::LINEAR_HDR;
    case DOMICILE_TRANSFER_PQ:
      return gfx::ColorSpace::TransferID::PQ;
    case DOMICILE_TRANSFER_HLG:
      return gfx::ColorSpace::TransferID::HLG;
    case DOMICILE_TRANSFER_SCRGB:
      return gfx::ColorSpace::TransferID::SCRGB_LINEAR_80_NITS;
    default:
      return gfx::ColorSpace::TransferID::SRGB;
  }
}

}  // namespace

BufferColor BufferColorFrom(const DomicileColor& color) {
  BufferColor buffer;
  buffer.color_space = gfx::ColorSpace(PrimariesFrom(color.primaries),
                                       TransferFrom(color.transfer));
  if (color.has_mastering) {
    skhdr::MasteringDisplayColorVolume mastering;
    mastering.fDisplayPrimaries = {
        color.mastering_red.x,   color.mastering_red.y,
        color.mastering_green.x, color.mastering_green.y,
        color.mastering_blue.x,  color.mastering_blue.y,
        color.mastering_white.x, color.mastering_white.y};
    mastering.fMinimumDisplayMasteringLuminance = color.mastering_min_luminance;
    mastering.fMaximumDisplayMasteringLuminance = color.mastering_max_luminance;
    buffer.hdr_metadata.SetMDCV(mastering);
  }
  if (color.max_cll > 0 || color.max_fall > 0) {
    skhdr::ContentLightLevelInformation light;
    light.fMaxCLL = color.max_cll;
    light.fMaxFALL = color.max_fall;
    buffer.hdr_metadata.SetCLLI(light);
  }
  // Only HDR content has a reference white to place: SDR content's white is
  // the display's.
  if (color.reference_luminance > 0 && buffer.color_space.IsHDR()) {
    buffer.hdr_metadata.SetHdrReferenceWhite(color.reference_luminance);
  }
  return buffer;
}

}  // namespace domicile
