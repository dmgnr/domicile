// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_POINTER_CONFINEMENT_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_POINTER_CONFINEMENT_H_

#include <vector>

#include "base/functional/callback.h"
#include "content/public/browser/global_routing_id.h"
#include "ui/gfx/geometry/rect_f.h"

namespace domicile {

// Holds the pointer inside `boxes`, in the coordinates of the page in `frame`,
// until the page lets go with no boxes or goes away. For a game's or VM
// viewer's zwp_pointer_constraints_v1 confinement, which the shell passes on.
//
// The policy is components/domicile/browser/pointer_warp.h, which has the
// tests; the cursor's half is ui/ozone/platform/drm/domicile. This half maps
// the page to its aura host, as `WarpPointerIn` does.
//
// Answers whether the pointer is held: not when nested in another compositor
// or headless, where this process does not move the pointer, nor for a frame
// that closed or boxes that are nowhere on the page.
//
// Must be called on the UI thread. `frame` is an id for `WarpPointerIn`'s
// reason.
void ConfinePointerIn(content::GlobalRenderFrameHostId frame,
                      const std::vector<gfx::RectF>& boxes,
                      base::OnceCallback<void(bool confined)> confined);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_POINTER_CONFINEMENT_H_
