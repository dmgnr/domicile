// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <drm_fourcc.h>
#include <xf86drmMode.h>

#include <cstdint>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/gpu_fence_handle.h"
#include "ui/gfx/linux/gbm_buffer.h"
#include "ui/gfx/linux/test/mock_gbm_device.h"
#include "ui/gfx/presentation_feedback.h"
#include "ui/gfx/swap_result.h"
#include "ui/ozone/platform/drm/gpu/crtc_commit_request.h"
#include "ui/ozone/platform/drm/gpu/crtc_controller.h"
#include "ui/ozone/platform/drm/gpu/drm_framebuffer.h"
#include "ui/ozone/platform/drm/gpu/drm_overlay_plane.h"
#include "ui/ozone/platform/drm/gpu/fake_drm_device.h"
#include "ui/ozone/platform/drm/gpu/hardware_display_controller.h"
#include "ui/ozone/platform/drm/gpu/page_flip_watchdog.h"

namespace ui {
namespace {

// A 6x4 mode, as upstream's HardwareDisplayController tests use.
const drmModeModeInfo kMode = {0, 6, 0, 0, 0, 0, 4, 0,
                               0, 0, 0, 0, 0, 0, {'\0'}};
const gfx::Size kModeSize(kMode.hdisplay, kMode.vdisplay);

// Matches `kPageFlipTimeout` in hardware_display_controller.cc.
constexpr base::TimeDelta kTimeout = base::Seconds(1);

// One lit atomic CRTC. The fake device holds each flip's event until
// `RunCallbacks`, so a flip whose event never comes is one it is never run
// for: what a DisplayLink dock (evdi) does when it drops a flip.
class DrmPageFlipTimeoutTest : public testing::Test {
 protected:
  void SetUp() override {
    drm_ = base::MakeRefCounted<FakeDrmDevice>(
        std::make_unique<MockGbmDevice>());
    drm_->ResetStateWithDefaultObjects(/*crtc_count=*/1,
                                       /*planes_per_crtc=*/1);
    drm_->AddProperty(drm_->crtc_property(0).id,
                      {.id = kVrrEnabledPropId, .value = 0});
    drm_->InitializeState(/*use_atomic=*/true);
    controller_ = std::make_unique<HardwareDisplayController>(
        std::make_unique<CrtcController>(drm_.get(),
                                         drm_->crtc_property(0).id,
                                         kConnectorIdBase),
        gfx::Point(), /*drm_modifiers_filter=*/nullptr);

    Modeset();
  }

  void TearDown() override {
    controller_.reset();
    drm_->ResetPlaneManagerForTesting();
    drm_->ClearCallbacks();
  }

  scoped_refptr<DrmFramebuffer> Buffer() {
    std::unique_ptr<GbmBuffer> buffer = drm_->gbm_device()->CreateBuffer(
        DRM_FORMAT_XRGB8888, kModeSize, GBM_BO_USE_SCANOUT);
    return DrmFramebuffer::AddFramebuffer(drm_, buffer.get(), kModeSize);
  }

  void Modeset() {
    DrmOverlayPlaneList planes;
    planes.push_back(DrmOverlayPlane::TestPlane(Buffer()));
    CommitRequest request;
    controller_->GetModesetProps(&request, planes, kMode, vrr_);
    CommitRequest applied = request;
    ASSERT_TRUE(drm_->plane_manager()->Commit(std::move(request),
                                              DRM_MODE_ATOMIC_ALLOW_MODESET));
    for (const CrtcCommitRequest& crtc_request : applied) {
      controller_->UpdateState(crtc_request);
    }
  }

  void Flip() {
    DrmOverlayPlaneList planes;
    planes.push_back(DrmOverlayPlane::TestPlane(Buffer()));
    controller_->SchedulePageFlip(
        std::move(planes),
        base::BindOnce(
            [](gfx::SwapResult* last, gfx::SwapResult result,
               gfx::GpuFenceHandle) { *last = result; },
            &last_swap_),
        base::BindOnce(
            [](int* presented, int* failed, uint32_t* flags,
               const gfx::PresentationFeedback& feedback) {
              ++*presented;
              *failed += feedback.failed() ? 1 : 0;
              *flags = feedback.flags;
            },
            &presented_, &failed_, &flags_));
  }

  base::test::SingleThreadTaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME,
      base::test::SingleThreadTaskEnvironment::MainThreadType::UI};
  scoped_refptr<FakeDrmDevice> drm_;
  std::unique_ptr<HardwareDisplayController> controller_;
  gfx::SwapResult last_swap_ = gfx::SwapResult::SWAP_FAILED;
  int presented_ = 0;
  int failed_ = 0;
  // The last presentation's `gfx::PresentationFeedback::Flags`.
  uint32_t flags_ = 0;
  // Whether `Modeset` turns on a variable refresh rate.
  bool vrr_ = false;
};

// Without the event the window waits for its presentation forever, and so
// does everything drawn through it.
TEST_F(DrmPageFlipTimeoutTest, AFlipThatNeverFinishesIsGivenUpOn) {
  Flip();
  task_environment_.FastForwardBy(kTimeout - base::Milliseconds(1));
  EXPECT_EQ(presented_, 0);

  task_environment_.FastForwardBy(base::Milliseconds(1));
  EXPECT_EQ(presented_, 1);
  EXPECT_EQ(failed_, 1);
}

// The display draws on: the next flip the kernel takes is scheduled and
// presents.
TEST_F(DrmPageFlipTimeoutTest, TheDisplayFlipsAgainAfterOneIsGivenUpOn) {
  Flip();
  task_environment_.FastForwardBy(kTimeout);

  last_swap_ = gfx::SwapResult::SWAP_FAILED;
  Flip();
  EXPECT_EQ(last_swap_, gfx::SwapResult::SWAP_ACK);
  // Also delivers the lost flip's event, late, which answers nothing more.
  drm_->RunCallbacks();
  EXPECT_EQ(presented_, 2);
  EXPECT_EQ(failed_, 1);
}

// The kernel refuses commits while it holds the lost flip. Those frames are
// skipped, and the watchdog is not armed, so the GPU process lives on.
TEST_F(DrmPageFlipTimeoutTest, ACommitRefusedAfterALostFlipIsSkipped) {
  Flip();
  task_environment_.FastForwardBy(kTimeout);

  drm_->set_commit_expectation(false);
  Flip();
  EXPECT_EQ(last_swap_, gfx::SwapResult::SWAP_ACK);
  EXPECT_EQ(presented_, 2);
  EXPECT_EQ(failed_, 2);

  task_environment_.FastForwardBy(kWaitForModesetTimeout);
}

// Long after the kernel would have let the lost flip go, a refused commit is
// a real failure again.
TEST_F(DrmPageFlipTimeoutTest, ACommitRefusedLongAfterALostFlipFails) {
  Flip();
  task_environment_.FastForwardBy(kTimeout + base::Seconds(15));

  drm_->set_commit_expectation(false);
  Flip();
  EXPECT_EQ(last_swap_, gfx::SwapResult::SWAP_FAILED);
}

// A modeset takes the CRTC back, so a refused commit after it is a real
// failure again.
TEST_F(DrmPageFlipTimeoutTest, ACommitRefusedAfterAModesetFails) {
  Flip();
  task_environment_.FastForwardBy(kTimeout);
  Modeset();

  drm_->set_commit_expectation(false);
  Flip();
  EXPECT_EQ(last_swap_, gfx::SwapResult::SWAP_FAILED);
}

// A modeset forgets the pending flip but not its callback, and the flip after
// it does not take that flip's timeout: both are answered.
TEST_F(DrmPageFlipTimeoutTest, AFlipAModesetForgotIsStillGivenUpOn) {
  Flip();
  Modeset();
  Flip();
  task_environment_.FastForwardBy(kTimeout);
  EXPECT_EQ(presented_, 2);
  EXPECT_EQ(failed_, 2);
}

// The kernel let go of a flip a modeset forgot, so giving up on it later
// leaves refused commits to the watchdog.
TEST_F(DrmPageFlipTimeoutTest, ACommitRefusedAfterAForgottenFlipFails) {
  Flip();
  Modeset();
  task_environment_.FastForwardBy(kTimeout);
  EXPECT_EQ(failed_, 1);

  drm_->set_commit_expectation(false);
  Flip();
  EXPECT_EQ(last_swap_, gfx::SwapResult::SWAP_FAILED);
}

// A flip that finishes in time presents once, and the timeout never fires.
TEST_F(DrmPageFlipTimeoutTest, AFlipThatFinishesIsNotGivenUpOn) {
  Flip();
  drm_->RunCallbacks();
  task_environment_.FastForwardBy(kTimeout * 2);
  EXPECT_EQ(presented_, 1);
  EXPECT_EQ(failed_, 0);
}

// A fixed refresh rate flips on vsync, so viz phases its frames to the flip.
TEST_F(DrmPageFlipTimeoutTest, AFlipAtAFixedRefreshRateIsOnVsync) {
  Flip();
  drm_->RunCallbacks();
  EXPECT_EQ(presented_, 1);
  EXPECT_TRUE(flags_ & gfx::PresentationFeedback::kVSync);
}

// With a variable refresh rate the panel scans out when the flip lands, so a
// flip is not a vsync: phasing viz's frames to it adds each frame's drawing
// time to the next one's interval, and every animation stutters.
TEST_F(DrmPageFlipTimeoutTest, AFlipAtAVariableRefreshRateIsNotOnVsync) {
  vrr_ = true;
  Modeset();
  ASSERT_TRUE(controller_->crtc_controllers()[0]->vrr_enabled());

  Flip();
  drm_->RunCallbacks();
  EXPECT_EQ(presented_, 1);
  EXPECT_EQ(failed_, 0);
  EXPECT_FALSE(flags_ & gfx::PresentationFeedback::kVSync);
  EXPECT_TRUE(flags_ & gfx::PresentationFeedback::kHWCompletion);
}

}  // namespace
}  // namespace ui
