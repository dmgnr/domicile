// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/core/html/domicile/layout_app_surface.h"

#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/core/html/domicile/html_app_element.h"
#include "third_party/blink/renderer/core/paint/paint_info.h"
#include "third_party/blink/renderer/platform/graphics/paint/foreign_layer_display_item.h"

namespace blink {

LayoutAppSurface::LayoutAppSurface(HTMLAppElement* element)
    : LayoutReplaced(element) {}

void LayoutAppSurface::UpdateAfterLayout() {
  NOT_DESTROYED();
  LayoutReplaced::UpdateAfterLayout();

  // Pixel-snapped to match the layer bounds in PaintReplaced(). A mismatch
  // would scale the window. The element ignores an unchanged size and zoom.
  if (auto* app = DynamicTo<HTMLAppElement>(GetNode())) {
    app->SurfaceBoxChanged(ToPixelSnappedRect(ReplacedContentRect()).size(),
                           CssZoom());
  }
}

// The effective zoom holds the page's own density and page zoom too (zoom for
// device scale factor), which the frame's layout zoom factor is. What is left
// is the CSS `zoom` of this element and its ancestors.
double LayoutAppSurface::CssZoom() const {
  NOT_DESTROYED();
  return Style().EffectiveZoom() / GetFrame()->LayoutZoomFactor();
}

PhysicalNaturalSizingInfo LayoutAppSurface::GetNaturalDimensions() const {
  NOT_DESTROYED();
  // The page sizes the window, not the reverse. An unsized <app> gets the
  // replaced element default, not the client's last buffer size.
  return PhysicalNaturalSizingInfo::None();
}

void LayoutAppSurface::PaintReplaced(const PaintInfo& paint_info,
                                     const PhysicalOffset& paint_offset) const {
  NOT_DESTROYED();
  auto* app = DynamicTo<HTMLAppElement>(GetNode());
  if (!app) {
    return;
  }
  cc::Layer* layer = app->ContentsCcLayer();
  if (!layer || paint_info.ShouldOmitCompositingInfo()) {
    // No producer yet: show the page background.
    return;
  }

  PhysicalRect paint_rect = ReplacedContentRect();
  paint_rect.Move(paint_offset);
  gfx::Rect pixel_snapped_rect = ToPixelSnappedRect(paint_rect);

  layer->SetBounds(pixel_snapped_rect.size());
  layer->SetIsDrawable(true);
  // Hit-testable for the page. Domicile routes input to clients itself, so viz
  // does not need to.
  layer->SetHitTestable(true);

  // Puts the window in the page's property trees, so CSS transform, clip,
  // opacity, filter and blend apply to it like any other layer.
  RecordForeignLayer(paint_info.context, *this,
                     DisplayItem::kForeignLayerAppSurface, layer,
                     pixel_snapped_rect.origin());
}

}  // namespace blink
