// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_H_
#define UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_H_

#include <memory>

#include "base/memory/raw_ref.h"
#include "ui/base/dragdrop/mojom/drag_drop_types.mojom.h"
#include "ui/base/dragdrop/os_exchange_data.h"
#include "ui/gfx/geometry/point_f.h"

namespace ui {
class WmDropHandler;
}

namespace views {

// One drag on the desk, told where the pointer goes and handing each step to
// `target`, the desk window's drop handler. See `DeskDragHandler`, which feeds
// it the desk's events.
//
// - The first move enters `target` and hands it a copy of the data.
// - A release drops on `target` if it took an operation, and leaves it if not.
// - A cancel leaves `target`. Canceling an ended drag does nothing:
//   `DesktopDragDropClientOzone` cancels after a drop nobody performed.
class DeskDrag {
 public:
  // `operations` is the source's `ui::DragDropTypes` bitmask.
  DeskDrag(ui::WmDropHandler& target,
           const ui::OSExchangeData& data,
           int operations);

  DeskDrag(const DeskDrag&) = delete;
  DeskDrag& operator=(const DeskDrag&) = delete;

  ~DeskDrag();

  // The pointer is at `at`, in the desk window's root DIPs. `modifiers` are
  // `ui::EventFlags`.
  void Move(const gfx::PointF& at, int modifiers);

  // The button or finger came up. Returns the operation the drop took.
  ui::mojom::DragOperation Release(int modifiers);

  void Cancel();

  // What the target last said it would take.
  ui::mojom::DragOperation operation() const { return operation_; }

  bool ended() const { return ended_; }

 private:
  const raw_ref<ui::WmDropHandler> target_;
  std::unique_ptr<ui::OSExchangeData> data_;
  const int operations_;
  bool entered_ = false;
  bool ended_ = false;
  ui::mojom::DragOperation operation_ = ui::mojom::DragOperation::kNone;
};

}  // namespace views

#endif  // UI_VIEWS_WIDGET_DESKTOP_AURA_DOMICILE_DESK_DRAG_H_
