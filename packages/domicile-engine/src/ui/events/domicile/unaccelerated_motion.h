// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef UI_EVENTS_DOMICILE_UNACCELERATED_MOTION_H_
#define UI_EVENTS_DOMICILE_UNACCELERATED_MOTION_H_

#include <array>
#include <optional>

#include "base/check_op.h"
#include "base/containers/span.h"
#include "ui/events/event.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace ui {

// How far the device moved, before pointer acceleration, in the same pixels as
// the accelerated motion that moved the cursor. For zwp_relative_pointer_v1's
// unaccelerated deltas, which games and VM viewers read.
//
// An event property, as the scroll metadata is, because properties survive
// aura's copies and the browser's own motion is left as it was.
inline constexpr char kUnacceleratedMotion[] = "domicile-unaccelerated-motion";

inline void SetUnacceleratedMotion(Event& event, const gfx::Vector2dF& motion) {
  Event::Properties properties =
      event.properties() ? *event.properties() : Event::Properties();
  const std::array<float, 2> deltas = {motion.x(), motion.y()};
  auto& bytes = properties[kUnacceleratedMotion];
  bytes.resize(sizeof(deltas));
  base::span(bytes).copy_from(
      base::as_byte_span(base::allow_nonunique_obj, deltas));
  event.SetProperties(properties);
}

// Nothing for a move whose device reported no unaccelerated motion: a nested
// desktop's host, emulated input, or a move nobody made.
inline std::optional<gfx::Vector2dF> GetUnacceleratedMotion(
    const Event& event) {
  if (!event.properties()) {
    return std::nullopt;
  }
  const auto found = event.properties()->find(kUnacceleratedMotion);
  if (found == event.properties()->end()) {
    return std::nullopt;
  }
  std::array<float, 2> deltas;
  CHECK_EQ(found->second.size(), sizeof(deltas));
  base::as_writable_byte_span(base::allow_nonunique_obj, deltas)
      .copy_from(base::span(found->second));
  return gfx::Vector2dF(deltas[0], deltas[1]);
}

}  // namespace ui

#endif  // UI_EVENTS_DOMICILE_UNACCELERATED_MOTION_H_
