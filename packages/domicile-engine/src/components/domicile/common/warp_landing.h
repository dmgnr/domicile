// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_COMMON_WARP_LANDING_H_
#define COMPONENTS_DOMICILE_COMMON_WARP_LANDING_H_

#include <cmath>
#include <optional>

#include "ui/gfx/geometry/point_f.h"

namespace domicile {

// Which pointer move is the shell's own warp landing, so that it reaches no
// client as relative motion.
//
// A warp moves the pointer, and nobody moved it. The browser reports a warp as
// a move (synthesized, which Blink does not see), and Blink measures its
// `movementX/Y` from where the pointer was, so it would reach a game as a
// flick of the mouse. The move that lands where the page last warped, within
// a pixel, is taken as the warp. A warp the browser skipped or clamped leaves
// its target waiting, which costs at most one later move that lands exactly
// there.
//
// Header only, so Blink keeps it and the tests need no Blink. In the page's
// CSS pixels.
class WarpLanding {
 public:
  // The page warped the pointer to `to`.
  void Warped(const gfx::PointF& to) { target_ = to; }

  // Whether the move that reached `at` is the last warp landing, which it is
  // only once.
  bool Landed(const gfx::PointF& at) {
    if (!target_ || std::abs(target_->x() - at.x()) >= 1 ||
        std::abs(target_->y() - at.y()) >= 1) {
      return false;
    }
    target_.reset();
    return true;
  }

 private:
  std::optional<gfx::PointF> target_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_COMMON_WARP_LANDING_H_
