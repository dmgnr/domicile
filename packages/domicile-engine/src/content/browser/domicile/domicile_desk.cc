// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "content/browser/domicile/domicile_desk.h"

#include <optional>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "components/domicile/browser/desk_geometry.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/host/host_frame_sink_manager.h"
#include "content/browser/compositor/surface_utils.h"
#include "content/browser/renderer_host/render_widget_host_view_base.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/web_contents.h"
#include "ui/aura/client/aura_constants.h"
#include "ui/aura/client/window_types.h"
#include "ui/aura/window.h"
#include "ui/base/class_property.h"
#include "ui/compositor/layer.h"

DEFINE_UI_CLASS_PROPERTY_TYPE(display::ScreenInfos*)

namespace content {
namespace {

// Set on the contents' window and read from its descendants, since each
// RenderWidgetHostView (one per renderer) adds a child window. Looked up by
// walking parents because aura::Window does not inherit properties.
DEFINE_OWNED_UI_CLASS_PROPERTY_KEY(display::ScreenInfos,
                                   kDomicileDeskScreenInfosKey)

// aura_constants.h already defines the gfx::Rect* property type.
DEFINE_OWNED_UI_CLASS_PROPERTY_KEY(gfx::Rect, kDomicileDeskPageBoundsKey)

struct Desk {
  // Empty before the first layout. See `GetDomicileDesk`.
  std::optional<std::vector<DomicileDeskDisplay>> lit =
      std::vector<DomicileDeskDisplay>();
  base::RepeatingClosureList observers;
};

Desk& TheDesk() {
  static base::NoDestructor<Desk> desk;
  return *desk;
}

// Not a frame sink parent of the page. viz gives a sink its first parent's
// BeginFrameSource and, after a detach, picks by pointer order, so a second
// parent could leave the page ticking at a slower monitor. Referencing the
// page's surface is enough for viz to draw it here.
class Mirror : public DomicileDeskMirror {
 public:
  explicit Mirror(RenderWidgetHostViewBase* view)
      : view_(view->GetWeakPtr()),
        layer_(view->GetNativeView()->layer()->Mirror()) {}

  Mirror(const Mirror&) = delete;
  Mirror& operator=(const Mirror&) = delete;

  ui::Layer* layer() override { return layer_.get(); }

  bool Mirrors(WebContents* page) const override {
    return view_ && view_.get() == page->GetRenderWidgetHostView();
  }

 private:
  base::WeakPtr<RenderWidgetHostViewBase> view_;
  std::unique_ptr<ui::Layer> layer_;
};

}  // namespace

std::unique_ptr<DomicileDeskMirror> MirrorDomicileDeskPage(WebContents* page) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  auto* view =
      static_cast<RenderWidgetHostViewBase*>(page->GetRenderWidgetHostView());
  if (view == nullptr || view->GetNativeView() == nullptr) {
    return nullptr;
  }
  return std::make_unique<Mirror>(view);
}

std::optional<std::vector<DomicileDeskDisplay>> GetDomicileDesk() {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  return TheDesk().lit;
}

base::CallbackListSubscription AddDomicileDeskObserver(
    base::RepeatingClosure changed) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  return TheDesk().observers.Add(std::move(changed));
}

void DomicileDeskLaidOut(std::optional<std::vector<DomicileDeskDisplay>> lit) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  if (TheDesk().lit == lit) {
    return;
  }
  TheDesk().lit = std::move(lit);
  TheDesk().observers.Notify();
}

void SetDomicileDeskScreenInfos(WebContents* contents,
                                std::optional<display::ScreenInfos> infos) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  aura::Window* window = contents->GetNativeView();
  if (infos.has_value()) {
    window->SetProperty(kDomicileDeskScreenInfosKey, std::move(*infos));
  } else {
    window->ClearProperty(kDomicileDeskScreenInfosKey);
  }
  auto* view = static_cast<RenderWidgetHostViewBase*>(
      contents->GetRenderWidgetHostView());
  if (view != nullptr) {
    view->UpdateScreenInfo();
  }
}

std::optional<display::ScreenInfos> DomicileDeskScreenInfosFor(
    gfx::NativeView view) {
  for (aura::Window* window = view; window != nullptr;
       window = window->parent()) {
    const display::ScreenInfos* infos =
        window->GetProperty(kDomicileDeskScreenInfosKey);
    if (infos != nullptr) {
      // Offset each monitor's rect by the page's screen position, so widgets
      // in the page (including a <webview>) can find their monitor from their
      // own screen rect.
      display::ScreenInfos placed = *infos;
      const gfx::Vector2d corner =
          window->GetBoundsInScreen().origin().OffsetFromOrigin();
      for (display::ScreenInfo& info : placed.screen_infos) {
        info.rect += corner;
        info.available_rect += corner;
      }
      // A popup, such as a <select>'s list, fits itself on its monitor.
      if (view->GetType() == aura::client::WINDOW_TYPE_MENU) {
        return domicile::PopupScreenInfos(std::move(placed),
                                          view->GetBoundsInScreen());
      }
      return placed;
    }
  }
  return std::nullopt;
}

display::ScreenInfos DomicileFrameScreenInfos(display::ScreenInfos parent,
                                              const gfx::Rect& bounds) {
  return domicile::FrameScreenInfos(std::move(parent), bounds);
}

void SetDomicileDeskPageBounds(gfx::NativeWindow window,
                               std::optional<gfx::Rect> bounds) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  if (bounds.has_value()) {
    window->SetProperty(kDomicileDeskPageBoundsKey, *bounds);
  } else {
    window->ClearProperty(kDomicileDeskPageBoundsKey);
  }
}

std::optional<gfx::Rect> GetDomicileDeskPageBounds(gfx::NativeWindow window) {
  if (window == nullptr) {
    return std::nullopt;
  }
  const gfx::Rect* bounds = window->GetProperty(kDomicileDeskPageBoundsKey);
  if (bounds == nullptr) {
    return std::nullopt;
  }
  return *bounds;
}

base::ScopedClosureRunner AddDomicileFrameSinkChild(
    const viz::FrameSinkId& parent,
    const viz::FrameSinkId& child) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  // Viz keeps a parent's children after the parent is invalidated, so the
  // undo below finds this one even once the shell's renderer is gone.
  if (!GetHostFrameSinkManager()->RegisterFrameSinkHierarchy(parent, child)) {
    return base::ScopedClosureRunner();
  }
  return base::ScopedClosureRunner(base::BindOnce(
      [](const viz::FrameSinkId& parent, const viz::FrameSinkId& child) {
        GetHostFrameSinkManager()->UnregisterFrameSinkHierarchy(parent, child);
      },
      parent, child));
}

}  // namespace content
