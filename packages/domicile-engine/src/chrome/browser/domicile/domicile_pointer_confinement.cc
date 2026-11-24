// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_pointer_confinement.h"

#include <optional>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/logging.h"
#include "components/domicile/browser/pointer_warp.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/ozone/public/ozone_platform.h"

namespace domicile {
namespace {

// Lets go of the pointer when the frame that confined it goes away: a shell
// that reloads or crashes cannot let go itself, and a pointer held for a page
// that is gone could never leave its box.
class ConfinementHolder
    : public content::WebContentsObserver,
      public content::WebContentsUserData<ConfinementHolder> {
 public:
  ~ConfinementHolder() override { LetGo(); }

  // Remembers that `frame` holds the pointer in `widget`, or that nothing
  // does.
  void Held(content::GlobalRenderFrameHostId frame,
            std::optional<gfx::AcceleratedWidget> widget) {
    frame_ = frame;
    widget_ = widget;
  }

  // content::WebContentsObserver:
  void RenderFrameDeleted(content::RenderFrameHost* frame) override {
    if (frame->GetGlobalId() == frame_) {
      LetGo();
    }
  }

 private:
  friend class content::WebContentsUserData<ConfinementHolder>;

  explicit ConfinementHolder(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<ConfinementHolder>(*contents) {}

  void LetGo() {
    if (!widget_.has_value()) {
      return;
    }
    // Whether it lets go is no news: the platform held the pointer, so it
    // can let go of it.
    ui::OzonePlatform::GetInstance()->SetDomicilePointerConfinement(*widget_,
                                                                    {});
    widget_.reset();
  }

  content::GlobalRenderFrameHostId frame_;
  std::optional<gfx::AcceleratedWidget> widget_;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ConfinementHolder);

}  // namespace

void ConfinePointerIn(content::GlobalRenderFrameHostId frame_id,
                      const std::vector<gfx::RectF>& boxes,
                      base::OnceCallback<void(bool confined)> confined) {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  content::RenderFrameHost* frame = content::RenderFrameHost::FromID(frame_id);
  // The frame closed before this ran; whatever it held, it let go.
  if (frame == nullptr) {
    std::move(confined).Run(false);
    return;
  }
  gfx::NativeView view = frame->GetNativeView();
  aura::Window* root =
      view == gfx::NativeView() ? nullptr : view->GetRootWindow();
  if (root == nullptr) {
    // The frame has no window, as in unit tests or during teardown.
    std::move(confined).Run(false);
    return;
  }
  const std::optional<std::vector<gfx::RectF>> in_root =
      PointerConfinementBoxes(view->GetBoundsInRootWindow(), boxes);
  if (!in_root.has_value()) {
    // Blink rejects boxes that are not boxes, and the shell confines to its
    // own windows, so reaching here suggests an unexpected renderer.
    LOG(WARNING) << "domicile: a page asked for the pointer to be held in "
                 << boxes.size() << " boxes, which are nowhere on it";
    std::move(confined).Run(false);
    return;
  }

  // The cursor moves in the host's pixels.
  aura::WindowTreeHost* host = root->GetHost();
  std::vector<gfx::RectF> in_pixels;
  for (const gfx::RectF& box : *in_root) {
    gfx::PointF origin = box.origin();
    gfx::PointF far = box.bottom_right();
    host->ConvertDIPToPixels(&origin);
    host->ConvertDIPToPixels(&far);
    in_pixels.push_back(gfx::BoundingRect(origin, far));
  }
  const gfx::AcceleratedWidget widget = host->GetAcceleratedWidget();
  const bool held =
      ui::OzonePlatform::GetInstance()->SetDomicilePointerConfinement(
          widget, in_pixels);

  content::WebContents* contents =
      content::WebContents::FromRenderFrameHost(frame);
  ConfinementHolder::CreateForWebContents(contents);
  ConfinementHolder::FromWebContents(contents)->Held(
      frame_id, held && !in_pixels.empty()
                    ? std::optional<gfx::AcceleratedWidget>(widget)
                    : std::nullopt);
  std::move(confined).Run(held);
}

}  // namespace domicile
