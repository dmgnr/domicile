// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/views/widget/desktop_aura/domicile/desk_drag_handler.h"

#include <utility>

#include "base/check.h"
#include "base/memory/weak_ptr.h"
#include "base/run_loop.h"
#include "ui/aura/env.h"
#include "ui/aura/window.h"
#include "ui/base/cursor/cursor.h"
#include "ui/base/dragdrop/os_exchange_data.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/paint_recorder.h"
#include "ui/events/event.h"
#include "ui/events/event_target.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/point_conversions.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/platform_window/wm/wm_drop_handler.h"

namespace views {

DeskDragHandler::DeskDragHandler(aura::Window* root,
                                 ui::PlatformWindow& platform_window)
    : root_(root), platform_window_(platform_window) {}

DeskDragHandler::~DeskDragHandler() {
  // The desk window can close in the middle of a drag. `StartDrag` sees the
  // weak pointer gone and returns.
  if (drag_ && !drag_->ended()) {
    End();
  }
}

bool DeskDragHandler::StartDrag(const ui::OSExchangeData& data,
                                int operations,
                                ui::mojom::DragEventSource source,
                                gfx::NativeCursor cursor,
                                bool can_grab_pointer,
                                base::OnceClosure drag_started_callback,
                                DragFinishedCallback drag_finished_callback,
                                LocationDelegate* location_delegate) {
  // `DesktopDragDropClientOzone` refuses a second drag before asking.
  CHECK(!drag_) << "domicile: a drag started during another";
  ui::WmDropHandler* target = ui::GetWmDropHandler(*platform_window_);
  CHECK(target) << "domicile: the desk window has no drop handler";

  drag_ = std::make_unique<DeskDrag>(*target, data, operations);
  location_delegate_ = location_delegate;
  shown_operation_.reset();
  last_at_.reset();
  image_ = data.provider().GetDragImage();
  image_offset_ = data.provider().GetDragImageOffset();

  base::WeakPtr<DeskDragHandler> alive = weak_factory_.GetWeakPtr();
  base::RunLoop loop(base::RunLoop::Type::kNestableTasksAllowed);
  quit_ = loop.QuitClosure();
  aura::Env::GetInstance()->AddPreTargetHandler(
      this, ui::EventTarget::Priority::kSystem);
  std::move(drag_started_callback).Run();
  loop.Run();
  if (!alive) {
    return false;
  }

  image_layer_.reset();
  location_delegate_ = nullptr;
  const bool canceled = canceled_;
  canceled_ = false;
  const ui::mojom::DragOperation operation = drag_->operation();
  drag_.reset();
  std::move(drag_finished_callback).Run(operation);
  return !canceled;
}

void DeskDragHandler::CancelDrag() {
  if (drag_ && !drag_->ended()) {
    Cancel();
  }
}

void DeskDragHandler::UpdateDragImage(const gfx::ImageSkia& image,
                                      const gfx::Vector2d& offset) {
  CHECK(drag_) << "domicile: a drag image changed with no drag";
  image_ = image;
  image_offset_ = offset;
  PlaceImage();
}

void DeskDragHandler::OnEvent(ui::Event* event) {
  // No page hears the pointer or the keys while a drag holds them, as on
  // every platform whose window manager runs the drag.
  event->StopPropagation();
  switch (event->type()) {
    case ui::EventType::kMouseMoved:
    case ui::EventType::kMouseDragged:
    case ui::EventType::kTouchMoved:
      Move(event->AsLocatedEvent()->root_location_f(), event->flags());
      return;
    case ui::EventType::kMouseReleased:
    case ui::EventType::kTouchReleased:
      Release(event->flags());
      return;
    case ui::EventType::kTouchCancelled:
      Cancel();
      return;
    case ui::EventType::kKeyPressed:
      if (event->AsKeyEvent()->key_code() == ui::VKEY_ESCAPE) {
        Cancel();
      }
      return;
    default:
      return;
  }
}

void DeskDragHandler::OnPaintLayer(const ui::PaintContext& context) {
  ui::PaintRecorder recorder(context, image_layer_->size());
  recorder.canvas()->DrawImageInt(image_, 0, 0);
}

void DeskDragHandler::OnDeviceScaleFactorChanged(
    float old_device_scale_factor,
    float new_device_scale_factor) {}

void DeskDragHandler::Move(const gfx::PointF& at, int modifiers) {
  drag_->Move(at, modifiers);
  last_at_ = at;
  PlaceImage();
  const ui::mojom::DragOperation operation = drag_->operation();
  if (location_delegate_ && shown_operation_ != operation) {
    shown_operation_ = operation;
    location_delegate_->OnDragOperationChanged(operation);
  }
}

void DeskDragHandler::Release(int modifiers) {
  drag_->Release(modifiers);
  End();
}

void DeskDragHandler::Cancel() {
  canceled_ = true;
  drag_->Cancel();
  End();
}

void DeskDragHandler::End() {
  aura::Env::GetInstance()->RemovePreTargetHandler(this);
  std::move(quit_).Run();
}

void DeskDragHandler::PlaceImage() {
  if (image_.isNull() || !last_at_.has_value()) {
    if (image_layer_) {
      image_layer_->SetVisible(false);
    }
    return;
  }
  if (!image_layer_) {
    image_layer_ = ui::Layer::Create(ui::LAYER_TEXTURED);
    image_layer_->set_delegate(this);
    image_layer_->SetFillsBoundsOpaquely(false);
    root_->layer()->Add(image_layer_.get());
  }
  root_->layer()->StackAtTop(image_layer_.get());
  image_layer_->SetBounds(gfx::Rect(
      gfx::ToFlooredPoint(*last_at_) - image_offset_, image_.size()));
  image_layer_->SetVisible(true);
  image_layer_->SchedulePaint(gfx::Rect(image_layer_->size()));
}

}  // namespace views
