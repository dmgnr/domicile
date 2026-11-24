// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_cursor_factory.h"

#include <optional>
#include <utility>

#include "base/containers/flat_map.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/run_loop.h"
#include "base/test/mock_log.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/cursor/cursor_factory.h"
#include "ui/base/cursor/domicile/desk_cursor_theme.h"
#include "ui/base/cursor/domicile/xcursor_theme.h"
#include "ui/base/cursor/mojom/cursor_type.mojom-shared.h"
#include "ui/gfx/geometry/point.h"
#include "ui/ozone/common/bitmap_cursor.h"

namespace ui {
namespace {

TEST(DrmCursorFactoryTest, EveryOrdinaryCursorIsAnsweredWithNothing) {
  DrmCursorFactory factory;

  // Null makes `CursorLoader` load the art from `ui_lottie_resources`. The
  // base's bitmapless cursor would turn the cursor plane off.
  for (const mojom::CursorType type : {
           mojom::CursorType::kPointer,
           mojom::CursorType::kHand,
           mojom::CursorType::kIBeam,
           mojom::CursorType::kWait,
           mojom::CursorType::kNorthWestSouthEastResize,
       }) {
    EXPECT_EQ(factory.GetDefaultCursor(type), nullptr)
        << "cursor type " << static_cast<int>(type);
  }
}

TEST(DrmCursorFactoryTest, TheInvisibleCursorIsStillAnObjectWithAType) {
  DrmCursorFactory factory;

  // `CursorLoader` always asks the platform for `kNone`, and `DrmCursor`
  // hides the cursor on that type. Null would show an arrow instead.
  const scoped_refptr<PlatformCursor> none =
      factory.GetDefaultCursor(mojom::CursorType::kNone);

  ASSERT_NE(none, nullptr);
  EXPECT_EQ(BitmapCursor::FromPlatformCursor(none)->type(),
            mojom::CursorType::kNone);
  EXPECT_TRUE(BitmapCursor::FromPlatformCursor(none)->bitmaps().empty());
}

TEST(DrmCursorFactoryTest, TheScaledOverloadAnswersTheSameWay) {
  DrmCursorFactory concrete;

  // Held as the base and called with a scale, as `CursorLoader` does.
  CursorFactory& factory = concrete;

  EXPECT_EQ(factory.GetDefaultCursor(mojom::CursorType::kPointer, 2.0f),
            nullptr);
  EXPECT_NE(factory.GetDefaultCursor(mojom::CursorType::kNone, 2.0f), nullptr);
}

TEST(DrmCursorFactoryTest, AnImageCursorIsStillMade) {
  DrmCursorFactory factory;

  // Image cursors still work: app cursors and CSS `cursor` values arrive as
  // bitmaps and bypass `GetDefaultCursor`.
  SkBitmap bitmap;
  bitmap.allocN32Pixels(4, 4);
  bitmap.eraseColor(SK_ColorRED);

  const scoped_refptr<PlatformCursor> image = factory.CreateImageCursor(
      mojom::CursorType::kCustom, bitmap, gfx::Point(1, 1), 1.0f);

  ASSERT_NE(image, nullptr);
  EXPECT_FALSE(BitmapCursor::FromPlatformCursor(image)->bitmaps().empty());
}

TEST(DrmCursorFactoryTest, APageCursorIsTurnedBeforeItGetsHere) {
  DrmCursorFactory concrete;
  const CursorFactory& factory = concrete;

  // A CRTC shows the cursor plane as it is given. A page's cursor image must
  // be turned for a rotated panel first, as the themed ones are.
  EXPECT_TRUE(factory.ShowsCursorsUnturned());
}

SkBitmap Square(int size, SkColor color) {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(size, size);
  bitmap.eraseColor(color);
  return bitmap;
}

// A theme whose arrow is a square as wide as the pixels it was loaded at. Only
// the theme named "Hands" has a hand.
base::flat_map<mojom::CursorType, XCursorImages> FakeTheme(
    const DeskCursorTheme& theme,
    int size) {
  base::flat_map<mojom::CursorType, XCursorImages> cursors;
  if (theme.name == "Missing") {
    return cursors;
  }
  cursors[mojom::CursorType::kPointer] = {
      .frames = {Square(size, SK_ColorRED)}, .hotspot = gfx::Point(3, 4)};
  cursors[mojom::CursorType::kWait] = {
      .frames = {Square(size, SK_ColorRED), Square(size, SK_ColorBLUE)},
      .frame_delay = base::Milliseconds(40)};
  if (theme.name == "Hands") {
    cursors[mojom::CursorType::kHand] = {.frames = {Square(size, SK_ColorRED)}};
  }
  return cursors;
}

class DrmCursorFactoryThemeTest : public testing::Test,
                                  public CursorFactoryObserver {
 protected:
  void SetUp() override { factory_.AddObserver(this); }
  void TearDown() override { factory_.RemoveObserver(this); }

  // CursorFactoryObserver:
  void OnThemeLoaded() override {
    ++told_;
    if (quit_) {
      std::move(quit_).Run();
    }
  }

  // Waits for the factory to say cursors loaded.
  void WaitForCursors() {
    base::RunLoop loop;
    quit_ = loop.QuitClosure();
    loop.Run();
  }

  base::test::TaskEnvironment task_environment_;
  DeskCursorThemeSource source_;
  DrmCursorFactory factory_{source_, base::BindRepeating(&FakeTheme)};
  int told_ = 0;
  base::OnceClosure quit_;
};

// Loading reads the disk, so the first answer is Chromium's art. The loader
// redraws when the factory says the theme loaded.
TEST_F(DrmCursorFactoryThemeTest, TheDesksThemeIsDrawnOnceItLoads) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});

  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kPointer, 2.0f),
            nullptr);
  WaitForCursors();

  const scoped_refptr<BitmapCursor> arrow = BitmapCursor::FromPlatformCursor(
      factory_.GetDefaultCursor(mojom::CursorType::kPointer, 2.0f));
  ASSERT_NE(arrow, nullptr);
  ASSERT_EQ(arrow->bitmaps().size(), 1u);
  // 24 logical pixels at twice the density.
  EXPECT_EQ(arrow->bitmaps()[0].width(), 48);
  EXPECT_EQ(arrow->hotspot(), gfx::Point(3, 4));

  const scoped_refptr<BitmapCursor> wait = BitmapCursor::FromPlatformCursor(
      factory_.GetDefaultCursor(mojom::CursorType::kWait, 2.0f));
  ASSERT_NE(wait, nullptr);
  EXPECT_EQ(wait->bitmaps().size(), 2u);
  EXPECT_EQ(wait->frame_delay(), base::Milliseconds(40));
}

// On a turned monitor `CursorLoader` turns the theme's cursor as it turns
// Chromium's art. Every frame goes through its turn, each with the theme's
// hotspot.
TEST_F(DrmCursorFactoryThemeTest, TheThemesCursorIsTurnedForItsMonitor) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kWait);
  WaitForCursors();

  const scoped_refptr<BitmapCursor> wait =
      BitmapCursor::FromPlatformCursor(factory_.GetTurnedDefaultCursor(
          mojom::CursorType::kWait, 1.0f,
          [](SkBitmap& frame, gfx::Point& hotspot) {
            frame = Square(frame.width() * 2, SK_ColorGREEN);
            hotspot.Offset(10, 0);
          }));

  ASSERT_NE(wait, nullptr);
  ASSERT_EQ(wait->bitmaps().size(), 2u);
  for (const SkBitmap& frame : wait->bitmaps()) {
    EXPECT_EQ(frame.width(), 48);
    EXPECT_EQ(frame.getColor(0, 0), SK_ColorGREEN);
  }
  EXPECT_EQ(wait->hotspot(), gfx::Point(10, 0));
  EXPECT_EQ(wait->frame_delay(), base::Milliseconds(40));
}

TEST_F(DrmCursorFactoryThemeTest, ACursorTheThemeLacksIsChromiumsArt) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer);
  WaitForCursors();

  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);
  EXPECT_NE(factory_.GetDefaultCursor(mojom::CursorType::kNone), nullptr);
}

// `kNull` names no cursor, which is the default pointer: the theme's arrow,
// not Chromium's. `wm::CursorLoader` asks for it whenever the cursor client
// holds no cursor, as it does when the pointer comes back from hiding.
TEST_F(DrmCursorFactoryThemeTest, NoCursorNamedIsTheThemesArrow) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer);
  WaitForCursors();

  const scoped_refptr<BitmapCursor> none_named =
      BitmapCursor::FromPlatformCursor(
          factory_.GetDefaultCursor(mojom::CursorType::kNull));
  ASSERT_NE(none_named, nullptr);
  ASSERT_EQ(none_named->bitmaps().size(), 1u);
  EXPECT_EQ(none_named->bitmaps()[0].width(), 24);
  EXPECT_EQ(none_named->hotspot(), gfx::Point(3, 4));
}

// A reload that names another theme drops the cursors loaded from the old
// one, and says so, so the loader asks again and redraws.
TEST_F(DrmCursorFactoryThemeTest, AnotherThemeReplacesTheCursorsOfTheLast) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer);
  WaitForCursors();
  const int told_of_amber = told_;

  source_.Set(DeskCursorTheme{.name = "Hands", .size = 24});

  EXPECT_EQ(told_, told_of_amber + 1);
  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);
  WaitForCursors();
  EXPECT_NE(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);

  source_.Set(std::nullopt);

  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);
}

// A monitor at another density asks for a size not loaded yet. The nearest
// loaded size stands in until it loads, so the pointer stays the theme's
// across a hotplug instead of turning into Chromium's art.
TEST_F(DrmCursorFactoryThemeTest, TheNearestLoadedSizeStandsInWhileOneLoads) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer, 1.0f);
  WaitForCursors();
  factory_.GetDefaultCursor(mojom::CursorType::kPointer, 2.0f);
  WaitForCursors();

  const scoped_refptr<BitmapCursor> stand_in = BitmapCursor::FromPlatformCursor(
      factory_.GetDefaultCursor(mojom::CursorType::kPointer, 1.75f));
  ASSERT_NE(stand_in, nullptr);
  ASSERT_EQ(stand_in->bitmaps().size(), 1u);
  // 42 pixels is nearer 48 than 24.
  EXPECT_EQ(stand_in->bitmaps()[0].width(), 48);
  EXPECT_EQ(stand_in->cursor_image_scale_factor(), 2.0f);
  EXPECT_EQ(stand_in->hotspot(), gfx::Point(3, 4));

  WaitForCursors();
  const scoped_refptr<BitmapCursor> loaded = BitmapCursor::FromPlatformCursor(
      factory_.GetDefaultCursor(mojom::CursorType::kPointer, 1.75f));
  ASSERT_NE(loaded, nullptr);
  EXPECT_EQ(loaded->bitmaps()[0].width(), 42);
  EXPECT_EQ(loaded->cursor_image_scale_factor(), 1.75f);
}

// Chromium's art while the first size loads is expected on every start, so
// it is no error: the theme's own failures are.
TEST_F(DrmCursorFactoryThemeTest,
       DrawingChromiumsArtWhileTheThemeLoadsIsNoError) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  base::test::MockLog log;
  EXPECT_CALL(log, Log).Times(testing::AnyNumber());
  EXPECT_CALL(log, Log(logging::LOGGING_ERROR, testing::_, testing::_,
                       testing::_, testing::_))
      .Times(0);
  log.StartCapturingLogs();

  factory_.GetDefaultCursor(mojom::CursorType::kPointer, 2.0f);
  factory_.GetDefaultCursor(mojom::CursorType::kHand, 2.0f);

  log.StopCapturingLogs();
  WaitForCursors();
}

TEST_F(DrmCursorFactoryThemeTest, ACursorTheThemeLacksIsAnError) {
  source_.Set(DeskCursorTheme{.name = "Amber", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer);
  WaitForCursors();
  base::test::MockLog log;
  EXPECT_CALL(log, Log).Times(testing::AnyNumber());
  EXPECT_CALL(log, Log(logging::LOGGING_ERROR, testing::_, testing::_,
                       testing::_, testing::HasSubstr("has no cursor for")))
      .Times(1);
  log.StartCapturingLogs();

  // Once per type, not once per pointer move.
  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);
  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kHand), nullptr);

  log.StopCapturingLogs();
}

TEST_F(DrmCursorFactoryThemeTest, AThemeOffTheXCursorPathIsAnError) {
  source_.Set(DeskCursorTheme{.name = "Missing", .size = 24});
  factory_.GetDefaultCursor(mojom::CursorType::kPointer);
  base::test::MockLog log;
  EXPECT_CALL(log, Log).Times(testing::AnyNumber());
  EXPECT_CALL(log, Log(logging::LOGGING_ERROR, testing::_, testing::_,
                       testing::_, testing::HasSubstr("no cursor theme")))
      .Times(1);
  log.StartCapturingLogs();

  WaitForCursors();

  log.StopCapturingLogs();
  EXPECT_EQ(factory_.GetDefaultCursor(mojom::CursorType::kPointer), nullptr);
}

}  // namespace
}  // namespace ui
