// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_ENGINE_BUFFER_COLOR_H_
#define COMPONENTS_DOMICILE_ENGINE_BUFFER_COLOR_H_

#include "components/domicile/engine/domicile_engine.h"
#include "ui/gfx/color_space.h"
#include "ui/gfx/hdr_metadata.h"

namespace domicile {

// The color a client's buffer is drawn in, as viz takes it: the SharedImage's
// color space, and the HDR metadata each frame showing it carries.
struct BufferColor {
  gfx::ColorSpace color_space = gfx::ColorSpace::CreateSRGB();
  gfx::HDRMetadata hdr_metadata;
};

// `color` as viz takes it. An unknown primaries or transfer value is sRGB's,
// since the compositor advertises only the ones listed in domicile_engine.h.
BufferColor BufferColorFrom(const DomicileColor& color);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_ENGINE_BUFFER_COLOR_H_
