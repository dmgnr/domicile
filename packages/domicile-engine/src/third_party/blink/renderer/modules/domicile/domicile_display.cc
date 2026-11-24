// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_display.h"

namespace blink {

DomicileDisplay::DomicileDisplay(const String& name,
                                 int32_t x,
                                 int32_t y,
                                 uint32_t width,
                                 uint32_t height,
                                 uint32_t scale,
                                 uint32_t mode_width,
                                 uint32_t mode_height,
                                 uint32_t refresh_mhz,
                                 const String& adaptive_sync,
                                 const String& hdr,
                                 uint32_t peak_luminance,
                                 uint32_t sdr_white,
                                 const String& transform)
    : name_(name),
      x_(x),
      y_(y),
      width_(width),
      height_(height),
      scale_(scale),
      mode_width_(mode_width),
      mode_height_(mode_height),
      refresh_mhz_(refresh_mhz),
      adaptive_sync_(adaptive_sync),
      hdr_(hdr),
      peak_luminance_(peak_luminance),
      sdr_white_(sdr_white),
      transform_(transform) {}

DomicileDisplay::~DomicileDisplay() = default;

void DomicileDisplay::Trace(Visitor* visitor) const {
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink
