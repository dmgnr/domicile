// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <memory>
#include <vector>

#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/types/display_constants.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/linux/gbm_device.h"
#include "ui/ozone/platform/drm/gpu/fake_drm_device.h"
#include "ui/ozone/platform/drm/gpu/hardware_display_controller.h"
#include "ui/ozone/platform/drm/gpu/screen_manager.h"

namespace ui {
namespace {

constexpr drmModeModeInfo kMode = {.hdisplay = 6, .vdisplay = 4};

// A card with no 3D (2D virtio-gpu, simpledrm) has no GBM. `ScreenManager`
// modesets it with a dumb buffer (patch 0135).
TEST(DrmNoGbmModesetTest, ModesetsADeviceWithNoGbm) {
  // A DrmDevice is deleted on the sequence it was made on.
  base::test::SingleThreadTaskEnvironment task_environment;
  auto drm = base::MakeRefCounted<FakeDrmDevice>(/*gbm_device=*/nullptr);
  drm->ResetStateWithDefaultObjects(/*crtc_count=*/1, /*planes_per_crtc=*/1);
  drm->InitializeState(/*use_atomic=*/true);
  const uint32_t crtc_id = drm->crtc_property(0).id;
  const uint32_t connector_id = drm->connector_property(0).id;

  auto screen_manager = std::make_unique<ScreenManager>();
  screen_manager->AddDisplayController(drm, crtc_id, connector_id);
  std::vector<ControllerConfigParams> controllers_to_enable;
  controllers_to_enable.emplace_back(
      /*display_id=*/1, drm, crtc_id, connector_id, gfx::Point(),
      std::make_unique<drmModeModeInfo>(kMode));
  EXPECT_TRUE(screen_manager->ConfigureDisplayControllers(
      controllers_to_enable, {display::ModesetFlag::kTestModeset,
                              display::ModesetFlag::kCommitModeset}));

  EXPECT_EQ(drm->get_test_modeset_count(), 1);
  EXPECT_EQ(drm->get_commit_modeset_count(), 1);
  HardwareDisplayController* controller =
      screen_manager->GetDisplayController(gfx::Rect(0, 0, 6, 4));
  ASSERT_TRUE(controller);
  EXPECT_TRUE(controller->HasCrtc(drm, crtc_id));

  screen_manager.reset();
  drm->ResetPlaneManagerForTesting();
}

}  // namespace
}  // namespace ui
