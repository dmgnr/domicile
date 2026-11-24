// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/aura/domicile/desk_targeter.h"

#include <memory>

#include "base/check.h"
#include "base/memory/raw_ptr.h"
#include "base/scoped_observation.h"
#include "ui/aura/window.h"
#include "ui/aura/window_observer.h"
#include "ui/aura/window_targeter.h"
#include "ui/base/class_property.h"
#include "ui/events/event.h"
#include "ui/gfx/geometry/point_conversions.h"
#include "ui/gfx/geometry/rect_f.h"

namespace aura {
namespace {

// Marks a root whose targeter is a DeskTargeter. A property, not a
// dynamic_cast, because Chromium builds without RTTI.
DEFINE_UI_CLASS_PROPERTY_KEY(bool, kHasDeskTargeterKey, false)

class DeskTargeter : public WindowTargeter, public WindowObserver {
 public:
  explicit DeskTargeter(Window* page) { SetPage(page); }

  DeskTargeter(const DeskTargeter&) = delete;
  DeskTargeter& operator=(const DeskTargeter&) = delete;

  ~DeskTargeter() override = default;

  Window* page() const { return page_; }

  void SetPage(Window* page) {
    observation_.Reset();
    page_ = page;
    if (page_ != nullptr) {
      observation_.Observe(page_);
    }
  }

  // ui::EventTargeter:
  ui::EventTarget* FindTargetForEvent(ui::EventTarget* root,
                                      ui::Event* event) override {
    ui::EventTarget* target = WindowTargeter::FindTargetForEvent(root, event);
    Window* window = static_cast<Window*>(root);
    // Only redirect events the root would keep. This also runs for every
    // descendant window that has no targeter of its own.
    if ((target != nullptr && target != window) || window->parent() ||
        page_ == nullptr || !event->IsLocatedEvent() ||
        !window->Contains(page_)) {
      return target;
    }
    ui::LocatedEvent* located = event->AsLocatedEvent();
    if (!DeskPagePoint(window->bounds().size(), page_->GetBoundsInRootWindow(),
                       located->location_f())
             .has_value()) {
      return target;
    }
    // Call through ui::EventTarget: aura::Window's override is private.
    static_cast<ui::EventTarget*>(window)->ConvertEventToTarget(page_, located);
    return WindowTargeter::FindTargetForEvent(page_, event);
  }

 private:
  // WindowObserver:
  void OnWindowDestroying(Window* window) override { SetPage(nullptr); }

  raw_ptr<Window> page_ = nullptr;
  base::ScopedObservation<Window, WindowObserver> observation_{this};
};

}  // namespace

std::optional<gfx::PointF> DeskPagePoint(const gfx::Size& root,
                                         const gfx::Rect& page_in_root,
                                         const gfx::PointF& at) {
  if (gfx::RectF(gfx::Rect(root)).Contains(at) ||
      !gfx::RectF(page_in_root).Contains(at)) {
    return std::nullopt;
  }
  return at - gfx::Vector2dF(page_in_root.OffsetFromOrigin());
}

void TargetDeskPage(Window* root, Window* page) {
  CHECK(root != nullptr);
  CHECK(!root->parent());
  if (root->GetProperty(kHasDeskTargeterKey)) {
    static_cast<DeskTargeter*>(root->targeter())->SetPage(page);
    return;
  }
  // Leave a root with another targeter alone. The desk's host is a browser
  // window, whose root has none, and the dispatcher's default is a plain
  // WindowTargeter, which DeskTargeter extends.
  if (page == nullptr || root->targeter() != nullptr) {
    return;
  }
  root->SetEventTargeter(std::make_unique<DeskTargeter>(page));
  root->SetProperty(kHasDeskTargeterKey, true);
}

Window* DeskWindowAt(Window* root, const gfx::PointF& at) {
  CHECK(!root->parent());
  if (root->GetProperty(kHasDeskTargeterKey)) {
    Window* page = static_cast<DeskTargeter*>(root->targeter())->page();
    if (page != nullptr) {
      const std::optional<gfx::PointF> in_page = DeskPagePoint(
          root->bounds().size(), page->GetBoundsInRootWindow(), at);
      if (in_page.has_value()) {
        return page->GetEventHandlerForPoint(gfx::ToFlooredPoint(*in_page));
      }
    }
  }
  return root->GetEventHandlerForPoint(gfx::ToFlooredPoint(at));
}

}  // namespace aura
