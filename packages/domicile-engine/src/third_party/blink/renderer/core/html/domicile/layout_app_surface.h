// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_LAYOUT_APP_SURFACE_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_LAYOUT_APP_SURFACE_H_

#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/core/layout/layout_replaced.h"

namespace blink {

class HTMLAppElement;

// The layout box of an <app>, a replaced element like <video>.
//
// Reports the box size to the element, which configures the client, and
// records the element's cc::SurfaceLayer as a foreign layer.
class CORE_EXPORT LayoutAppSurface final : public LayoutReplaced {
 public:
  explicit LayoutAppSurface(HTMLAppElement*);

  const char* GetName() const override {
    NOT_DESTROYED();
    return "LayoutAppSurface";
  }

 private:
  void UpdateAfterLayout() override;
  // This element's CSS `zoom`, without the page's density and page zoom.
  double CssZoom() const;
  PhysicalNaturalSizingInfo GetNaturalDimensions() const override;
  void PaintReplaced(const PaintInfo&,
                     const PhysicalOffset& paint_offset) const override;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_LAYOUT_APP_SURFACE_H_
