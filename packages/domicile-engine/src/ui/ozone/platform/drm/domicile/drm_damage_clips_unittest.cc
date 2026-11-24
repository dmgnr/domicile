// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include <drm_fourcc.h>
#include <xf86drmMode.h>

#include <memory>

#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/rect.h"
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

const gfx::Size kBufferSize(4, 4);

// One atomic CRTC whose plane takes FB_DAMAGE_CLIPS, as evdi's primary does.
class DamageClipsCrtc {
 public:
  DamageClipsCrtc()
      : drm_(base::MakeRefCounted<FakeDrmDevice>(
            std::make_unique<MockGbmDevice>())) {
    drm_->ResetStateWithDefaultObjects(/*crtc_count=*/1,
                                       /*planes_per_crtc=*/1);
    crtc_id_ = drm_->crtc_property(0).id;
    plane_id_ = drm_->plane_property(0).id;
    drm_->AddProperty(plane_id_, {.id = kFbDamageClipsPropId, .value = 0});
    drm_->InitializeState(/*use_atomic=*/true);
  }

  ~DamageClipsCrtc() { drm_->ResetPlaneManagerForTesting(); }

  // Page-flips a frame that changed `damage`.
  void Flip(const gfx::Rect& damage) {
    DrmOverlayPlaneList planes;
    planes.push_back(DrmOverlayPlane::TestPlane(Buffer()));
    planes.back().damage_rect = damage;
    drm_->plane_manager()->BeginFrame(&state_);
    ASSERT_TRUE(drm_->plane_manager()->AssignOverlayPlanes(&state_, planes,
                                                           crtc_id_));
    drm_->set_commit_expectation(true);
    ASSERT_TRUE(drm_->plane_manager()->Commit(
        &state_, base::MakeRefCounted<PageFlipRequest>(base::TimeDelta()),
        /*release_fence=*/nullptr));
  }

  // The FB_DAMAGE_CLIPS blob the plane holds, 0 for none.
  uint64_t ClipBlob() {
    DrmDevice::Property clips{};
    ScopedDrmObjectPropertyPtr properties(
        drm_->GetObjectProperties(plane_id_, DRM_MODE_OBJECT_PLANE));
    EXPECT_TRUE(GetDrmPropertyForName(drm_.get(), properties.get(),
                                      "FB_DAMAGE_CLIPS", &clips));
    return clips.value;
  }

  // The rect the plane's clip names on this device. Empty when the blob is
  // not one of this device's.
  gfx::Rect Clip() {
    ScopedDrmPropertyBlobPtr blob = drm_->GetPropertyBlob(ClipBlob());
    if (!blob) {
      return gfx::Rect();
    }
    EXPECT_EQ(blob->length, sizeof(drm_mode_rect));
    const auto* rect = static_cast<const drm_mode_rect*>(blob->data);
    return gfx::Rect(rect->x1, rect->y1, rect->x2 - rect->x1,
                     rect->y2 - rect->y1);
  }

 private:
  scoped_refptr<DrmFramebuffer> Buffer() {
    std::unique_ptr<GbmBuffer> buffer = drm_->gbm_device()->CreateBuffer(
        DRM_FORMAT_XRGB8888, kBufferSize, GBM_BO_USE_SCANOUT);
    return DrmFramebuffer::AddFramebuffer(drm_, buffer.get(), kBufferSize);
  }

  scoped_refptr<FakeDrmDevice> drm_;
  uint32_t crtc_id_ = 0;
  uint32_t plane_id_ = 0;
  HardwareDisplayPlaneList state_;
};

// evdi hands DisplayLink each flip's clip to compress. A stale clip makes it
// compress the same rect every frame.
TEST(DrmDamageClipsTest, EachFlipNamesItsOwnDamage) {
  // A DrmDevice is deleted on the sequence it was made on.
  base::test::SingleThreadTaskEnvironment task_environment;
  DamageClipsCrtc crtc;

  crtc.Flip(gfx::Rect(0, 0, 4, 4));
  EXPECT_EQ(crtc.Clip(), gfx::Rect(0, 0, 4, 4));

  crtc.Flip(gfx::Rect(1, 2, 1, 1));
  EXPECT_EQ(crtc.Clip(), gfx::Rect(1, 2, 1, 1));
}

// A dock is a DRM device of its own. A blob id from another device names
// nothing there, or something else.
TEST(DrmDamageClipsTest, EachDeviceNamesItsOwnBlob) {
  // A DrmDevice is deleted on the sequence it was made on.
  base::test::SingleThreadTaskEnvironment task_environment;
  DamageClipsCrtc panel;
  DamageClipsCrtc dock;

  panel.Flip(gfx::Rect(0, 0, 4, 4));
  dock.Flip(gfx::Rect(2, 2, 2, 2));

  EXPECT_EQ(dock.Clip(), gfx::Rect(2, 2, 2, 2));
}

// No clip means the whole plane changed, which is right for a frame that
// names no damage.
TEST(DrmDamageClipsTest, AFlipWithNoDamageSendsNoClip) {
  // A DrmDevice is deleted on the sequence it was made on.
  base::test::SingleThreadTaskEnvironment task_environment;
  DamageClipsCrtc crtc;

  crtc.Flip(gfx::Rect(1, 1, 1, 1));
  crtc.Flip(gfx::Rect());

  EXPECT_EQ(crtc.ClipBlob(), 0u);
}

}  // namespace
}  // namespace ui
