// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <drm_fourcc.h>
#include <gbm.h>

#include <memory>
#include <string>
#include <vector>

#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/gpu_fence_handle.h"
#include "ui/gfx/linux/test/mock_gbm_device.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/gfx/overlay_plane_data.h"
#include "ui/ozone/platform/drm/gpu/fake_drm_device.h"
#include "ui/ozone/platform/drm/gpu/gbm_pixmap.h"

namespace ui {
namespace {

int g_warnings = 0;

bool CountWarnings(int severity,
                   const char* file,
                   int line,
                   size_t message_start,
                   const std::string& message) {
  if (severity >= logging::LOGGING_WARNING) {
    ++g_warnings;
  }
  return true;
}

// Schedules a `flags` buffer of each size twice and returns the warnings and
// errors logged. The pixmaps have no surface factory and no framebuffer, as
// `DrmThread` makes for a buffer without `GBM_BO_USE_SCANOUT`, so queuing a
// plane would crash. Each holds the device that allocated its buffer, as
// `GbmPixmap` requires since Chromium 160.0.8174.0.
//
// The skip is logged once per process, so each test uses its own sizes.
int WarningsSchedulingTwice(uint32_t flags,
                            const std::vector<gfx::Size>& sizes) {
  base::test::SingleThreadTaskEnvironment task_environment;
  auto drm = base::MakeRefCounted<FakeDrmDevice>(
      std::make_unique<MockGbmDevice>());
  std::vector<scoped_refptr<GbmPixmap>> pixmaps;
  for (const gfx::Size& size : sizes) {
    pixmaps.push_back(base::MakeRefCounted<GbmPixmap>(
        /*surface_manager=*/nullptr, drm,
        drm->gbm_device()->CreateBuffer(DRM_FORMAT_ARGB8888, size, flags),
        /*framebuffer=*/nullptr));
  }
  g_warnings = 0;
  const logging::LogMessageHandlerFunction previous =
      logging::GetLogMessageHandler();
  logging::SetLogMessageHandler(&CountWarnings);
  for (const scoped_refptr<GbmPixmap>& pixmap : pixmaps) {
    for (int frame = 0; frame < 2; ++frame) {
      EXPECT_TRUE(pixmap->ScheduleOverlayPlane(gfx::kNullAcceleratedWidget,
                                               gfx::OverlayPlaneData(),
                                               gfx::GpuFenceHandle()));
    }
  }
  logging::SetLogMessageHandler(previous);
  return g_warnings;
}

// A buffer queue holds several alike buffers, so one warning covers them all.
TEST(GbmPixmapScanoutTest, AlikeBuffersAreSkippedAndLoggedOnce) {
  EXPECT_EQ(WarningsSchedulingTwice(GBM_BO_USE_RENDERING,
                                    {gfx::Size(64, 64), gfx::Size(64, 64)}),
            1);
}

TEST(GbmPixmapScanoutTest, ABufferOfAnotherSizeIsLoggedAgain) {
  EXPECT_EQ(WarningsSchedulingTwice(GBM_BO_USE_RENDERING,
                                    {gfx::Size(32, 32), gfx::Size(48, 48)}),
            2);
}

TEST(GbmPixmapScanoutTest, AScanoutBufferLogsNothing) {
  EXPECT_EQ(WarningsSchedulingTwice(GBM_BO_USE_SCANOUT, {gfx::Size(16, 16)}),
            0);
}

}  // namespace
}  // namespace ui
