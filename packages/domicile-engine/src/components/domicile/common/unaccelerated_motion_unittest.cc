// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/events/domicile/unaccelerated_motion.h"

#include <memory>
#include <optional>

#include "mojo/public/cpp/test_support/test_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/input/web_coalesced_input_event.h"
#include "third_party/blink/public/common/input/web_coalesced_input_event_mojom_traits.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_pointer_event.h"
#include "third_party/blink/public/mojom/input/input_handler.mojom.h"
#include "ui/events/blink/web_input_event.h"
#include "ui/events/event.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace domicile {
namespace {

ui::MouseEvent AMove() {
  return ui::MouseEvent(ui::EventType::kMouseMoved, gfx::PointF(10, 20),
                        gfx::PointF(10, 20), base::TimeTicks(), 0, 0);
}

// Compared by its numbers, which gtest prints without gfx's test support.
void ExpectMotion(const std::optional<gfx::Vector2dF>& motion,
                  float x,
                  float y) {
  ASSERT_TRUE(motion.has_value());
  EXPECT_EQ(motion->x(), x);
  EXPECT_EQ(motion->y(), y);
}

blink::WebMouseEvent AWebMove() {
  return blink::WebMouseEvent(blink::WebInputEvent::Type::kMouseMove, 0,
                              base::TimeTicks());
}

TEST(UnacceleratedMotionTest, SurvivesEventCopiesIntoThePagesEvent) {
  ui::MouseEvent move = AMove();
  ui::SetUnacceleratedMotion(move, gfx::Vector2dF(1.5, -0.25));
  const ui::MouseEvent copied(move);
  ExpectMotion(ui::MakeWebMouseEvent(copied).unaccelerated_movement, 1.5,
               -0.25);
}

TEST(UnacceleratedMotionTest, AMoveNoDeviceMadeHasNone) {
  EXPECT_FALSE(ui::GetUnacceleratedMotion(AMove()).has_value());
  EXPECT_FALSE(
      ui::MakeWebMouseEvent(AMove()).unaccelerated_movement.has_value());
}

TEST(UnacceleratedMotionTest, CoalescedMovesAddUp) {
  blink::WebMouseEvent first = AWebMove();
  first.movement_x = 4;
  first.unaccelerated_movement = gfx::Vector2dF(1.5, -0.5);
  blink::WebMouseEvent next = first;
  next.unaccelerated_movement = gfx::Vector2dF(0.25, 2);
  ASSERT_TRUE(first.CanCoalesce(next));
  first.Coalesce(next);
  EXPECT_EQ(first.movement_x, 8);
  ExpectMotion(first.unaccelerated_movement, 1.75, 1.5);

  // Half a sum is no motion at all.
  next.unaccelerated_movement.reset();
  first.Coalesce(next);
  EXPECT_FALSE(first.unaccelerated_movement.has_value());
}

TEST(UnacceleratedMotionTest, CoalescedPointerMovesAddUp) {
  blink::WebMouseEvent mouse = AWebMove();
  mouse.unaccelerated_movement = gfx::Vector2dF(1, 2);
  blink::WebPointerEvent first(blink::WebInputEvent::Type::kPointerMove, mouse);
  ExpectMotion(first.unaccelerated_movement, 1, 2);
  const blink::WebPointerEvent next = first;
  ASSERT_TRUE(first.CanCoalesce(next));
  first.Coalesce(next);
  ExpectMotion(first.unaccelerated_movement, 2, 4);
}

TEST(UnacceleratedMotionTest, SurvivesRendererIpc) {
  blink::WebMouseEvent move = AWebMove();
  move.movement_x = 3;
  move.unaccelerated_movement = gfx::Vector2dF(1.5, -0.25);
  auto original =
      std::make_unique<blink::WebCoalescedInputEvent>(move, ui::LatencyInfo());
  std::unique_ptr<blink::WebCoalescedInputEvent> copied;
  ASSERT_TRUE(mojo::test::SerializeAndDeserialize<blink::mojom::Event>(original,
                                                                       copied));
  const auto& received =
      static_cast<const blink::WebMouseEvent&>(copied->Event());
  EXPECT_EQ(received.movement_x, 3);
  ExpectMotion(received.unaccelerated_movement, 1.5, -0.25);

  move.unaccelerated_movement.reset();
  original =
      std::make_unique<blink::WebCoalescedInputEvent>(move, ui::LatencyInfo());
  copied.reset();
  ASSERT_TRUE(mojo::test::SerializeAndDeserialize<blink::mojom::Event>(original,
                                                                       copied));
  EXPECT_FALSE(static_cast<const blink::WebMouseEvent&>(copied->Event())
                   .unaccelerated_movement.has_value());
}

}  // namespace
}  // namespace domicile
