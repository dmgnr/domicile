// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CONTENT_PUBLIC_BROWSER_DOMICILE_DESK_H_
#define CONTENT_PUBLIC_BROWSER_DOMICILE_DESK_H_

#include <stdint.h>

#include <memory>
#include <optional>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/callback_forward.h"
#include "base/functional/callback_helpers.h"
#include "content/common/content_export.h"
#include "ui/display/screen_infos.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"

namespace ui {
class Layer;
}  // namespace ui

namespace viz {
class FrameSinkId;
}  // namespace viz

namespace content {

class WebContents;

// A display and its place on the desk, from the compositor's layout.
//
// With --domicile-one-page, //chrome/browser/domicile lays out the single desk
// page from these. See docs/architecture/ONE-PAGE-FOR-THE-DESK.md.
struct DomicileDeskDisplay {
  int64_t id = 0;
  // In the desk's logical pixels.
  gfx::Rect desk;
  float scale = 1.0f;
  // False for a display that sleeps: dark, but keeping its place.
  bool lit = true;

  friend bool operator==(const DomicileDeskDisplay&,
                         const DomicileDeskDisplay&) = default;
};

// Returns the displays on the desk from the compositor's last layout: the lit
// ones, and the sleeping ones that keep their place. Empty before the first
// layout and on a blank. `std::nullopt` after an empty layout, which
// leaves every display where the hardware puts it (see docs/DISPLAYS.md).
// Nested runs send an empty layout too.
CONTENT_EXPORT std::optional<std::vector<DomicileDeskDisplay>>
GetDomicileDesk();

// Runs `changed` on the UI thread whenever the compositor's layout changes.
CONTENT_EXPORT base::CallbackListSubscription AddDomicileDeskObserver(
    base::RepeatingClosure changed);

// Overrides the screen info every page in `contents` sees; `std::nullopt`
// clears it. The desk page spans several displays, so it lays out at the
// desk's scale instead of its host display's.
CONTENT_EXPORT void SetDomicileDeskScreenInfos(
    WebContents* contents,
    std::optional<display::ScreenInfos> infos);

// Sets the bounds, in the window's DIPs, where `window` lays out the desk page
// instead of its client area; `std::nullopt` clears them. The page is larger
// than the window and offset so the window shows its own display's part.
// Chrome's browser view layout reads this.
CONTENT_EXPORT void SetDomicileDeskPageBounds(gfx::NativeWindow window,
                                              std::optional<gfx::Rect> bounds);
CONTENT_EXPORT std::optional<gfx::Rect> GetDomicileDeskPageBounds(
    gfx::NativeWindow window);

// Shows the desk page in another window by mirroring its surface layer, which
// viz draws at that window's scale. The page's frame sink stays parented only
// to the host's compositor, so it ticks at the host display's BeginFrames.
class CONTENT_EXPORT DomicileDeskMirror {
 public:
  virtual ~DomicileDeskMirror() = default;

  // Owned by this; the caller parents and places it.
  virtual ui::Layer* layer() = 0;

  // Whether this still mirrors `page`'s current view. A new renderer creates a
  // new view, which an old mirror does not show.
  virtual bool Mirrors(WebContents* page) const = 0;
};

// Mirrors `page`, or returns `nullptr` if it has no view yet.
CONTENT_EXPORT std::unique_ptr<DomicileDeskMirror> MirrorDomicileDeskPage(
    WebContents* page);

// Makes `child`, a page's video in picture-in-picture, a child of `parent`,
// the shell's frame sink that shows it, as Chrome's picture-in-picture window
// makes it a child of its own compositor. The video's player then draws at
// the desk's BeginFrames wherever its own page is. Returns what undoes it, or
// nothing when `parent` is not registered (its renderer is gone).
CONTENT_EXPORT base::ScopedClosureRunner AddDomicileFrameSinkChild(
    const viz::FrameSinkId& parent,
    const viz::FrameSinkId& child);

}  // namespace content

#endif  // CONTENT_PUBLIC_BROWSER_DOMICILE_DESK_H_
