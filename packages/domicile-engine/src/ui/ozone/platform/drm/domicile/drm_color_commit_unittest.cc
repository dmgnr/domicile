// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <drm_fourcc.h>
#include <xf86drmMode.h>

#include <memory>

#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/display/types/display_color_management.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/linux/gbm_buffer.h"
#include "ui/gfx/linux/test/mock_gbm_device.h"
#include "ui/ozone/platform/drm/gpu/drm_framebuffer.h"
#include "ui/ozone/platform/drm/gpu/drm_gpu_util.h"
#include "ui/ozone/platform/drm/gpu/drm_overlay_plane.h"
#include "ui/ozone/platform/drm/gpu/fake_drm_device.h"
#include "ui/ozone/platform/drm/gpu/hardware_display_plane_manager.h"
#include "ui/ozone/platform/drm/gpu/page_flip_request.h"

namespace ui {
namespace {

const gfx::Size kBufferSize(2, 2);

// A night light's gamma, warm enough that no curve mistakes it for identity.
display::GammaAdjustment Warm() {
  display::GammaAdjustment warm;
  warm.curve = display::GammaCurve::MakeScale(1.0, 0.7, 0.4);
  return warm;
}

// One atomic CRTC with a gamma table, so a gamma change is a GAMMA_LUT blob
// rather than the legacy ramp (patch 0161).
class DrmColorCommitTest : public testing::Test {
 protected:
  // A DrmDevice is deleted on the sequence it was made on.
  base::test::SingleThreadTaskEnvironment task_environment_;

  void SetUp() override {
    drm_ = base::MakeRefCounted<FakeDrmDevice>(
        std::make_unique<MockGbmDevice>());
    drm_->ResetStateWithDefaultObjects(/*crtc_count=*/1,
                                       /*planes_per_crtc=*/1);
    crtc_id_ = drm_->crtc_property(0).id;
    drm_->AddProperty(crtc_id_, {.id = kCtmPropId, .value = 0});
    drm_->AddProperty(crtc_id_, {.id = kDegammaLutSizePropId, .value = 33});
    drm_->AddProperty(crtc_id_, {.id = kDegammaLutPropId, .value = 0});
    drm_->AddProperty(crtc_id_, {.id = kGammaLutSizePropId, .value = 33});
    drm_->AddProperty(crtc_id_, {.id = kGammaLutPropId, .value = 0});
    drm_->InitializeState(/*use_atomic=*/true);
  }

  void TearDown() override { drm_->ResetPlaneManagerForTesting(); }

  // The GAMMA_LUT blob the CRTC holds, 0 for none.
  uint64_t GammaLut() {
    DrmDevice::Property gamma{};
    ScopedDrmObjectPropertyPtr properties(
        drm_->GetObjectProperties(crtc_id_, DRM_MODE_OBJECT_CRTC));
    EXPECT_TRUE(
        GetDrmPropertyForName(drm_.get(), properties.get(), "GAMMA_LUT",
                              &gamma));
    return gamma.value;
  }

  // Puts a plane on the CRTC and commits it: a page flip, or with `test`,
  // the test commit that checks one.
  void Flip(bool test = false) {
    DrmOverlayPlaneList planes;
    planes.push_back(DrmOverlayPlane::TestPlane(Buffer()));
    drm_->plane_manager()->BeginFrame(&state_);
    ASSERT_TRUE(drm_->plane_manager()->AssignOverlayPlanes(&state_, planes,
                                                           crtc_id_));
    drm_->set_commit_expectation(true);
    ASSERT_TRUE(drm_->plane_manager()->Commit(
        &state_,
        test ? nullptr
             : base::MakeRefCounted<PageFlipRequest>(base::TimeDelta()),
        /*release_fence=*/nullptr));
  }

  scoped_refptr<DrmFramebuffer> Buffer() {
    std::unique_ptr<GbmBuffer> buffer = drm_->gbm_device()->CreateBuffer(
        DRM_FORMAT_XRGB8888, kBufferSize, GBM_BO_USE_SCANOUT);
    return DrmFramebuffer::AddFramebuffer(drm_, buffer.get(), kBufferSize);
  }

  scoped_refptr<FakeDrmDevice> drm_;
  uint32_t crtc_id_ = 0;
  HardwareDisplayPlaneList state_;
};

// amdgpu takes a commit of a lit CRTC's gamma alone but keeps showing the old
// table until a modeset. KWin and Mutter send it with the next frame.
TEST_F(DrmColorCommitTest, ALitCrtcsGammaGoesWithTheNextPageFlip) {
  Flip();
  const int flipped = drm_->get_commit_count();

  drm_->plane_manager()->SetGammaAdjustment(crtc_id_, Warm());
  EXPECT_EQ(drm_->get_commit_count(), flipped);
  EXPECT_EQ(GammaLut(), 0u);

  Flip();
  EXPECT_EQ(drm_->get_commit_count(), flipped + 1);
  EXPECT_NE(GammaLut(), 0u);
}

// A test commit would use the change up, and the page flip it checks would
// go without.
TEST_F(DrmColorCommitTest, ATestCommitLeavesTheGammaForThePageFlip) {
  Flip();
  drm_->plane_manager()->SetGammaAdjustment(crtc_id_, Warm());

  Flip(/*test=*/true);
  EXPECT_EQ(GammaLut(), 0u);

  Flip();
  EXPECT_NE(GammaLut(), 0u);
}

// No plane, no page flip to wait for: the change is committed at once.
TEST_F(DrmColorCommitTest, ACrtcWithNoPlaneCommitsItsGammaAtOnce) {
  drm_->plane_manager()->SetGammaAdjustment(crtc_id_, Warm());
  EXPECT_EQ(drm_->get_commit_count(), 1);
  EXPECT_NE(GammaLut(), 0u);
}

}  // namespace
}  // namespace ui
