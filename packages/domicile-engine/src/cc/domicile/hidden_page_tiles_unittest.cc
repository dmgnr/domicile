// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <vector>

#include "base/test/task_environment.h"
#include "cc/test/fake_layer_tree_host_impl.h"
#include "cc/test/fake_picture_layer_impl.h"
#include "cc/test/fake_raster_source.h"
#include "cc/test/test_layer_tree_host_base.h"
#include "cc/tiles/picture_layer_tiling.h"
#include "cc/tiles/tile.h"
#include "cc/tiles/tile_manager.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace cc {
namespace {

// TestLayerTreeHostBase reads the current task runner as it is constructed,
// so the environment has to be a base that comes before it.
struct WithTaskEnvironment {
  base::test::TaskEnvironment task_environment;
};

// The page's viewport. The page is four times as wide and tall, so most of
// its tiles are prepaint.
constexpr gfx::Rect kViewport(500, 500);
constexpr gfx::Size kPage(2000, 2000);

class DomicileHiddenPageTilesTest : private WithTaskEnvironment,
                                    public TestLayerTreeHostBase {
 protected:
  void SetUp() override {
    TestLayerTreeHostBase::SetUp();
    host_impl()->active_tree()->SetDeviceViewportRect(kViewport);
  }

  LayerTreeSettings CreateSettings() override {
    LayerTreeSettings settings = TestLayerTreeHostBase::CreateSettings();
    settings.commit_to_active_tree = true;
    settings.gpu_rasterization_disabled = true;
    return settings;
  }

  // A page drawn with every tile it has rastered, the ones in its viewport
  // and its prepaint around them.
  std::vector<Tile*> DrawnPage() {
    SetupSyncTree(FakeRasterSource::CreateFilledWithText(kPage));
    std::vector<Tile*> tiles =
        active_layer()->HighResTiling()->AllTilesForTesting();
    host_impl()->tile_manager()->InitializeTilesWithResourcesForTesting(tiles);
    return tiles;
  }

  // Of `tiles`, the ones that still have their raster, split into those in
  // the viewport and those outside it.
  struct Kept {
    int in_viewport = 0;
    int outside = 0;
  };
  static Kept KeptOf(const std::vector<Tile*>& tiles) {
    Kept kept;
    for (Tile* tile : tiles) {
      if (!tile->draw_info().has_resource()) {
        continue;
      }
      if (tile->content_rect().Intersects(kViewport)) {
        kept.in_viewport += 1;
      } else {
        kept.outside += 1;
      }
    }
    return kept;
  }
};

// So the tests below that a hidden page drops it are not vacuous.
TEST_F(DomicileHiddenPageTilesTest, AShownPageHasPrepaint) {
  const std::vector<Tile*> tiles = DrawnPage();

  EXPECT_GT(KeptOf(tiles).outside, 0);
}

TEST_F(DomicileHiddenPageTilesTest, AHiddenPageKeepsTheTilesItDraws) {
  const std::vector<Tile*> tiles = DrawnPage();
  const int in_viewport = KeptOf(tiles).in_viewport;

  host_impl()->SetVisible(false);

  EXPECT_GT(in_viewport, 0);
  EXPECT_EQ(in_viewport, KeptOf(tiles).in_viewport);
}

TEST_F(DomicileHiddenPageTilesTest, AHiddenPageDropsItsPrepaint) {
  const std::vector<Tile*> tiles = DrawnPage();

  host_impl()->SetVisible(false);

  EXPECT_EQ(0, KeptOf(tiles).outside);
}

TEST_F(DomicileHiddenPageTilesTest, AShownAgainPageDrawsWhatItKept) {
  const std::vector<Tile*> tiles = DrawnPage();
  const int in_viewport = KeptOf(tiles).in_viewport;
  host_impl()->SetVisible(false);

  host_impl()->SetVisible(true);

  EXPECT_EQ(in_viewport, KeptOf(tiles).in_viewport);
}

}  // namespace
}  // namespace cc
