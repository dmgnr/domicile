// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/views/widget/desktop_aura/domicile/desk_drag.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/strings/utf_string_conversions.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/dragdrop/drag_drop_types.h"
#include "ui/base/dragdrop/os_exchange_data.h"
#include "ui/platform_window/wm/wm_drop_handler.h"

namespace views {
namespace {

using ui::mojom::DragOperation;

constexpr int kCopyOrMove =
    ui::DragDropTypes::DRAG_COPY | ui::DragDropTypes::DRAG_MOVE;

// Records each call as a line, and answers motion with `answer`.
class RecordingTarget : public ui::WmDropHandler {
 public:
  void OnDragEnter(const gfx::PointF& point,
                   int operations,
                   int modifiers) override {
    calls.push_back("enter " + point.ToString());
  }
  void OnDragDataAvailable(std::unique_ptr<ui::OSExchangeData> data) override {
    std::optional<std::u16string> text = data->GetString();
    calls.push_back("data " +
                    (text.has_value() ? std::string(text->begin(), text->end())
                                      : std::string("none")));
  }
  int OnDragMotion(const gfx::PointF& point,
                   int operations,
                   int modifiers) override {
    calls.push_back("motion " + point.ToString());
    return answer;
  }
  void OnDragDrop(int modifiers) override { calls.push_back("drop"); }
  void OnDragLeave() override { calls.push_back("leave"); }

  int answer = ui::DragDropTypes::DRAG_COPY;
  std::vector<std::string> calls;
};

std::unique_ptr<ui::OSExchangeData> Text(const char* text) {
  auto data = std::make_unique<ui::OSExchangeData>();
  data->SetString(base::ASCIIToUTF16(text));
  return data;
}

TEST(DeskDragTest, TheFirstMoveEntersWithTheData) {
  RecordingTarget target;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  drag.Move(gfx::PointF(1, 2), 0);
  drag.Move(gfx::PointF(3, 4), 0);
  EXPECT_EQ(target.calls,
            (std::vector<std::string>{"enter 1,2", "data hello",
                                      "motion 1,2", "motion 3,4"}));
}

TEST(DeskDragTest, AReleaseDropsWhatTheTargetTook) {
  RecordingTarget target;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  drag.Move(gfx::PointF(1, 2), 0);
  EXPECT_EQ(drag.Release(0), DragOperation::kCopy);
  EXPECT_EQ(target.calls.back(), "drop");
  EXPECT_TRUE(drag.ended());
}

TEST(DeskDragTest, AReleaseOnATargetThatTookNothingLeavesIt) {
  RecordingTarget target;
  target.answer = ui::DragDropTypes::DRAG_NONE;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  drag.Move(gfx::PointF(1, 2), 0);
  EXPECT_EQ(drag.Release(0), DragOperation::kNone);
  EXPECT_EQ(target.calls.back(), "leave");
}

TEST(DeskDragTest, AReleaseBeforeAnyMoveTellsTheTargetNothing) {
  RecordingTarget target;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  EXPECT_EQ(drag.Release(0), DragOperation::kNone);
  EXPECT_TRUE(target.calls.empty());
}

TEST(DeskDragTest, ACancelLeavesOnceAndForgetsTheOperation) {
  RecordingTarget target;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  drag.Move(gfx::PointF(1, 2), 0);
  drag.Cancel();
  drag.Cancel();
  EXPECT_EQ(drag.operation(), DragOperation::kNone);
  EXPECT_EQ(target.calls,
            (std::vector<std::string>{"enter 1,2", "data hello",
                                      "motion 1,2", "leave"}));
}

TEST(DeskDragTest, ACancelAfterADropChangesNothing) {
  RecordingTarget target;
  DeskDrag drag(target, *Text("hello"), kCopyOrMove);
  drag.Move(gfx::PointF(1, 2), 0);
  drag.Release(0);
  drag.Cancel();
  EXPECT_EQ(target.calls.back(), "drop");
}

}  // namespace
}  // namespace views
