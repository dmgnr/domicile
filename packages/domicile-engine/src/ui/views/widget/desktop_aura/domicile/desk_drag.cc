// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/views/widget/desktop_aura/domicile/desk_drag.h"

#include <utility>

#include "base/check.h"
#include "ui/base/dragdrop/drag_drop_types.h"
#include "ui/platform_window/wm/wm_drop_handler.h"

namespace views {

DeskDrag::DeskDrag(ui::WmDropHandler& target,
                   const ui::OSExchangeData& data,
                   int operations)
    : target_(target),
      data_(std::make_unique<ui::OSExchangeData>(data.provider().Clone())),
      operations_(operations) {}

DeskDrag::~DeskDrag() = default;

void DeskDrag::Move(const gfx::PointF& at, int modifiers) {
  CHECK(!ended_);
  if (!entered_) {
    entered_ = true;
    target_->OnDragEnter(at, operations_, modifiers);
    target_->OnDragDataAvailable(std::move(data_));
  }
  operation_ = ui::PreferredDragOperation(
      target_->OnDragMotion(at, operations_, modifiers));
}

ui::mojom::DragOperation DeskDrag::Release(int modifiers) {
  CHECK(!ended_);
  ended_ = true;
  if (!entered_) {
    return ui::mojom::DragOperation::kNone;
  }
  if (operation_ == ui::mojom::DragOperation::kNone) {
    target_->OnDragLeave();
  } else {
    target_->OnDragDrop(modifiers);
  }
  return operation_;
}

void DeskDrag::Cancel() {
  if (ended_) {
    return;
  }
  ended_ = true;
  operation_ = ui::mojom::DragOperation::kNone;
  if (entered_) {
    target_->OnDragLeave();
  }
}

}  // namespace views
