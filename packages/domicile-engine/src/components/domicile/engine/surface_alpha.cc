// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/engine/surface_alpha.h"

namespace domicile {

bool FourccHasAlpha(uint32_t fourcc) {
  switch (fourcc) {
    case 0x34325241:  // DRM_FORMAT_ARGB8888
    case 0x34324241:  // DRM_FORMAT_ABGR8888
    case 0x30335241:  // DRM_FORMAT_ARGB2101010
    case 0x30334241:  // DRM_FORMAT_ABGR2101010
    case 0x48344241:  // DRM_FORMAT_ABGR16161616F
      return true;
    default:
      return false;
  }
}

}  // namespace domicile
