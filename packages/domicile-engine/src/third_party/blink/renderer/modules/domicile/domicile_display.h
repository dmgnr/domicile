// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_DISPLAY_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_DISPLAY_H_

#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// One screen of the desktop, as the compositor described it.
//
// A ScriptWrappable because WebIDL does not allow a dictionary as an attribute
// type. See domicile_display.idl for the meaning of each field.
//
// Immutable. The compositor sends a new set of displays on every change, so a
// display held from an earlier set is stale.
class MODULES_EXPORT DomicileDisplay final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  DomicileDisplay(const String& name,
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
                  const String& transform);
  ~DomicileDisplay() override;

  const String& name() const { return name_; }
  int32_t x() const { return x_; }
  int32_t y() const { return y_; }
  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }
  uint32_t scale() const { return scale_; }
  uint32_t modeWidth() const { return mode_width_; }
  uint32_t modeHeight() const { return mode_height_; }
  uint32_t refreshMhz() const { return refresh_mhz_; }
  const String& adaptiveSync() const { return adaptive_sync_; }
  const String& hdr() const { return hdr_; }
  uint32_t peakLuminance() const { return peak_luminance_; }
  uint32_t sdrWhite() const { return sdr_white_; }
  const String& transform() const { return transform_; }

  void Trace(Visitor*) const override;

 private:
  String name_;
  int32_t x_ = 0;
  int32_t y_ = 0;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t scale_ = 1;
  // Zero means the compositor sent no mode. Do not default to the logical
  // size.
  uint32_t mode_width_ = 0;
  uint32_t mode_height_ = 0;
  // Zero means unknown.
  uint32_t refresh_mhz_ = 0;
  String adaptive_sync_;
  String hdr_;
  // Zero means unreported.
  uint32_t peak_luminance_ = 0;
  // Zero unless `hdr_` is `on`.
  uint32_t sdr_white_ = 0;
  String transform_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_DISPLAY_H_
