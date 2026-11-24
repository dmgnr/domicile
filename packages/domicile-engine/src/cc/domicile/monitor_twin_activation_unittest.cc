// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <memory>
#include <optional>
#include <set>

#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "cc/raster/raster_source.h"
#include "cc/test/fake_picture_layer_impl.h"
#include "cc/test/fake_raster_source.h"
#include "cc/test/test_layer_tree_host_base.h"
#include "cc/tiles/picture_layer_tiling.h"
#include "cc/tiles/picture_layer_tiling_set.h"
#include "cc/tiles/tile.h"
#include "cc/tiles/tiling_set_raster_queue_all.h"
#include "cc/tiles/tiling_set_raster_queue_required.h"
#include "cc/trees/layer_tree_settings.h"
#include "cc/trees/occlusion.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/axis_transform2d.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/geometry/vector2d_f.h"

namespace cc {
namespace {

// TestLayerTreeHostBase reads the current task runner as it is constructed,
// so the environment has to be a base that comes before it.
struct WithTaskEnvironment {
  base::test::TaskEnvironment task_environment;
};

// A page whose pending tree draws a less dense monitor from a tiling (0072),
// while on the active tree the twin of that tiling is an ordinary non-ideal
// one: the active tree has moved or resized off that monitor, or onto another
// raster scale. 0079 makes activation wait on the twin's tiles the pending
// tree shares, so the raster queue has to offer them, or the pending tree
// never activates and the page freezes at its old size.
class DomicileMonitorTwinActivationTest : private WithTaskEnvironment,
                                          public TestLayerTreeHostBase {
 protected:
  LayerTreeSettings CreateSettings() override {
    LayerTreeSettings settings = TestLayerTreeHostBase::CreateSettings();
    settings.commit_to_active_tree = false;
    settings.gpu_rasterization_disabled = true;
    return settings;
  }

  static PictureLayerTiling* AddHalfScaleTiling(FakePictureLayerImpl* layer) {
    PictureLayerTiling* tiling = layer->picture_layer_tiling_set()->AddTiling(
        gfx::AxisTransform2d(0.5f, gfx::Vector2dF()),
        scoped_refptr<RasterSource>(layer->GetRasterSource()));
    tiling->set_resolution(NON_IDEAL_RESOLUTION);
    return tiling;
  }

  // A time no earlier update used, so that every tiling is updated.
  static void Prioritize(FakePictureLayerImpl* layer,
                         const gfx::Size& bounds) {
    layer->picture_layer_tiling_set()->UpdateTilePriorities(
        gfx::Rect(bounds), 1.f, 1000.0, Occlusion(), true);
  }
};

TEST_F(DomicileMonitorTwinActivationTest,
       TheRasterQueueOffersEveryTileActivationWaitsOn) {
  const gfx::Size bounds(1000, 1000);
  scoped_refptr<FakeRasterSource> source =
      FakeRasterSource::CreateFilled(bounds);
  SetupTrees(source, source);

  // The active tiling was the monitor's when its tiles were made (a non-ideal
  // tiling with no monitor makes none), and has since stopped being.
  PictureLayerTiling* active_twin = AddHalfScaleTiling(active_layer());
  active_twin->SetDomicileDisplay(0.5f, std::nullopt);
  active_twin->CreateAllTilesForTesting();
  active_twin->SetDomicileDisplay(0.f, std::nullopt);
  ASSERT_FALSE(active_twin->AllTilesForTesting().empty());
  PictureLayerTiling* monitor = AddHalfScaleTiling(pending_layer());
  monitor->SetDomicileDisplay(0.5f, std::nullopt);
  Prioritize(active_layer(), bounds);
  Prioritize(pending_layer(), bounds);
  ASSERT_EQ(active_twin->domicile_display_ratio(), 0.f);

  std::set<const Tile*> required;
  for (std::unique_ptr<TilingSetRasterQueueRequired> queue =
           TilingSetRasterQueueRequired::Create(
               active_layer()->picture_layer_tiling_set(),
               RasterTilePriorityQueue::Type::REQUIRED_FOR_ACTIVATION);
       queue && !queue->IsEmpty(); queue->Pop()) {
    if (queue->Top().source_tiling() == active_twin) {
      required.insert(queue->Top().tile());
    }
  }
  ASSERT_FALSE(required.empty());

  std::set<const Tile*> offered;
  for (std::unique_ptr<TilingSetRasterQueueAll> queue =
           TilingSetRasterQueueAll::Create(
               active_layer()->picture_layer_tiling_set(), true);
       queue && !queue->IsEmpty(); queue->Pop()) {
    offered.insert(queue->Top().tile());
  }
  for (const Tile* tile : required) {
    EXPECT_TRUE(offered.contains(tile))
        << "tile " << tile->id() << " at " << tile->content_rect().ToString()
        << " is required for activation but never offered for raster";
  }
}

}  // namespace
}  // namespace cc
