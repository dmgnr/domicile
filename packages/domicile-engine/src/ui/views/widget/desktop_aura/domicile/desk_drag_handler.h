// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_HANDLER_H_
#define UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_HANDLER_H_

#include <memory>
#include <optional>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "ui/compositor/layer_delegate.h"
#include "ui/events/event_handler.h"
#include "ui/gfx/geometry/vector2d.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/platform_window/wm/wm_drag_handler.h"
#include "ui/views/widget/desktop_aura/domicile/desk_drag.h"

namespace aura {
class Window;
}

namespace ui {
class Layer;
class PlatformWindow;
}

namespace views {

// Runs drags on a platform with no window manager to run them: Ozone DRM and
// headless, where the engine is the whole desk. Upstream answers every drag
// there with `kNone` before it starts, so no page could drag text, an image or
// a link anywhere.
//
// The drag is the desk's own, as on ChromeOS:
//
// - Every pointer, touch and key event goes to the drag first (an `aura::Env`
//   pre-target handler), in the root window's DIPs.
// - Each move and the release go to the desk window's `ui::WmDropHandler`
//   (`DesktopDragDropClientOzone`) through `DeskDrag`.
// - Escape, or a touch cancel, cancels.
// - The drag image is a layer at the top of the root window, under the
//   pointer.
class DeskDragHandler : public ui::WmDragHandler,
                        public ui::EventHandler,
                        public ui::LayerDelegate {
 public:
  // `root` is the desk window's; `platform_window` carries its drop handler.
  DeskDragHandler(aura::Window* root, ui::PlatformWindow& platform_window);

  DeskDragHandler(const DeskDragHandler&) = delete;
  DeskDragHandler& operator=(const DeskDragHandler&) = delete;

  ~DeskDragHandler() override;

  // ui::WmDragHandler:
  bool StartDrag(const ui::OSExchangeData& data,
                 int operations,
                 ui::mojom::DragEventSource source,
                 gfx::NativeCursor cursor,
                 bool can_grab_pointer,
                 base::OnceClosure drag_started_callback,
                 DragFinishedCallback drag_finished_callback,
                 LocationDelegate* location_delegate) override;
  void CancelDrag() override;
  void UpdateDragImage(const gfx::ImageSkia& image,
                       const gfx::Vector2d& offset) override;

  // ui::EventHandler:
  void OnEvent(ui::Event* event) override;

  // ui::LayerDelegate:
  void OnPaintLayer(const ui::PaintContext& context) override;
  void OnDeviceScaleFactorChanged(float old_device_scale_factor,
                                  float new_device_scale_factor) override;

 private:
  // Moves the drag, its image, and the cursor with what the target takes.
  void Move(const gfx::PointF& at, int modifiers);
  void Release(int modifiers);
  void Cancel();
  // Stops listening and lets `StartDrag` return.
  void End();
  void PlaceImage();

  const raw_ptr<aura::Window> root_;
  const raw_ref<ui::PlatformWindow> platform_window_;

  // Set for the length of a drag.
  std::unique_ptr<DeskDrag> drag_;
  raw_ptr<LocationDelegate> location_delegate_ = nullptr;
  base::OnceClosure quit_;
  bool canceled_ = false;
  // The operation the cursor shows.
  std::optional<ui::mojom::DragOperation> shown_operation_;

  gfx::ImageSkia image_;
  gfx::Vector2d image_offset_;
  std::unique_ptr<ui::Layer> image_layer_;
  std::optional<gfx::PointF> last_at_;

  base::WeakPtrFactory<DeskDragHandler> weak_factory_{this};
};

}  // namespace views

#endif  // UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_HANDLER_H_
