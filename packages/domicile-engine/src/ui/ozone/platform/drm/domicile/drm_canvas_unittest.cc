// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "ui/ozone/platform/drm/domicile/drm_canvas.h"

#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/test/task_environment.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "third_party/skia/include/core/SkRect.h"
#include "third_party/skia/include/core/SkRefCnt.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "ui/gfx/frame_data.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/gpu_fence_handle.h"
#include "ui/gfx/linux/test/mock_gbm_device.h"
#include "ui/gfx/presentation_feedback.h"
#include "ui/gfx/swap_result.h"
#include "ui/ozone/platform/drm/gpu/drm_dumb_buffer.h"
#include "ui/ozone/platform/drm/gpu/drm_framebuffer.h"
#include "ui/ozone/platform/drm/gpu/fake_drm_device.h"

namespace ui {
namespace {

constexpr gfx::Size kSize(8, 4);

// One flip the canvas asked for.
struct AskedFlip {
  scoped_refptr<DrmFramebuffer> framebuffer;
  SwapCompletionOnceCallback submitted;
  PresentationOnceCallback presented;
};

// What the canvas allocated and flipped, for the test to look at.
struct Seen {
  // Each allocated buffer's pixels, in allocation order.
  std::vector<sk_sp<SkSurface>> buffers;
  std::vector<scoped_refptr<DrmFramebuffer>> framebuffers;
  std::vector<AskedFlip> flips;
};

// Allocates on a fake device, and holds each flip for the test to land.
class FakeDisplay : public DrmCanvas::Display {
 public:
  FakeDisplay(scoped_refptr<FakeDrmDevice> drm, Seen* seen)
      : drm_(std::move(drm)), seen_(seen) {}

  std::optional<DrmScanoutBuffer> Allocate(const gfx::Size& size) override {
    std::optional<DrmScanoutBuffer> buffer =
        AllocateDrmScanoutBuffer(drm_, size);
    seen_->buffers.push_back(sk_ref_sp(buffer->pixels->surface()));
    seen_->framebuffers.push_back(buffer->framebuffer);
    return buffer;
  }

  void Flip(scoped_refptr<DrmFramebuffer> framebuffer,
            SwapCompletionOnceCallback submitted,
            PresentationOnceCallback presented) override {
    seen_->flips.push_back(
        {std::move(framebuffer), std::move(submitted), std::move(presented)});
  }

 private:
  const scoped_refptr<FakeDrmDevice> drm_;
  const raw_ptr<Seen> seen_;
};

class DrmCanvasTest : public testing::Test {
 protected:
  DrmCanvasTest()
      : drm_(base::MakeRefCounted<FakeDrmDevice>(
            std::make_unique<MockGbmDevice>())),
        canvas_(std::make_unique<FakeDisplay>(drm_, &seen_)) {
    canvas_.ResizeCanvas(kSize, 1.f);
  }

  // Paints `rect` `color` and presents it as the frame's damage.
  void Present(const gfx::Rect& rect, SkColor color) {
    SkPaint paint;
    paint.setColor(color);
    canvas_.GetCanvas()->drawRect(SkRect::MakeXYWH(rect.x(), rect.y(),
                                                   rect.width(), rect.height()),
                                  paint);
    canvas_.PresentCanvas(rect);
  }

  // Lands flip `index` as `result`.
  void Land(size_t index, gfx::SwapResult result = gfx::SwapResult::SWAP_ACK) {
    AskedFlip& flip = seen_.flips[index];
    std::move(flip.submitted).Run(result, gfx::GpuFenceHandle());
    std::move(flip.presented).Run(gfx::PresentationFeedback());
  }

  SkColor PixelOf(size_t buffer, int x, int y) {
    SkBitmap bitmap;
    bitmap.allocN32Pixels(1, 1);
    EXPECT_TRUE(seen_.buffers[buffer]->readPixels(bitmap, x, y));
    return bitmap.getColor(0, 0);
  }

  // A DrmDevice is deleted on the sequence it was made on, so this outlives
  // every device.
  base::test::SingleThreadTaskEnvironment task_environment_;
  Seen seen_;
  scoped_refptr<FakeDrmDevice> drm_;
  DrmCanvas canvas_;
};

TEST_F(DrmCanvasTest, AFrameIsCopiedIntoABufferAndFlippedTo) {
  Present(gfx::Rect(kSize), SK_ColorRED);

  ASSERT_EQ(seen_.flips.size(), 1u);
  EXPECT_EQ(seen_.flips[0].framebuffer, seen_.framebuffers[0]);
  EXPECT_EQ(PixelOf(0, 3, 2), SK_ColorRED);
}

// The second buffer missed the first frame, so it gets it along with its own
// damage.
TEST_F(DrmCanvasTest, TheOtherBufferGetsWhatItMissed) {
  Present(gfx::Rect(kSize), SK_ColorRED);
  Land(0);
  Present(gfx::Rect(0, 0, 2, 2), SK_ColorBLUE);

  ASSERT_EQ(seen_.flips.size(), 2u);
  EXPECT_EQ(seen_.flips[1].framebuffer, seen_.framebuffers[1]);
  EXPECT_EQ(PixelOf(1, 1, 1), SK_ColorBLUE);
  EXPECT_EQ(PixelOf(1, 5, 3), SK_ColorRED);
}

TEST_F(DrmCanvasTest, ABufferCatchesUpOnTheFramesItSkipped) {
  Present(gfx::Rect(kSize), SK_ColorRED);
  Land(0);
  Present(gfx::Rect(0, 0, 2, 2), SK_ColorBLUE);
  Land(1);
  Present(gfx::Rect(6, 2, 2, 2), SK_ColorGREEN);

  ASSERT_EQ(seen_.flips.size(), 3u);
  EXPECT_EQ(seen_.flips[2].framebuffer, seen_.framebuffers[0]);
  EXPECT_EQ(PixelOf(0, 1, 1), SK_ColorBLUE);
  EXPECT_EQ(PixelOf(0, 7, 3), SK_ColorGREEN);
  EXPECT_EQ(PixelOf(0, 4, 0), SK_ColorRED);
}

// Viz paints the next frame only once the display lets go of a buffer.
TEST_F(DrmCanvasTest, TheSwapIsAcknowledgedWhenTheFlipLands) {
  std::optional<gfx::Size> acked;
  Present(gfx::Rect(kSize), SK_ColorRED);
  canvas_.OnSwapBuffers(
      base::BindOnce([](std::optional<gfx::Size>* acked,
                        const gfx::Size& size) { *acked = size; },
                     &acked),
      gfx::FrameData());

  EXPECT_FALSE(acked.has_value());
  Land(0);
  EXPECT_EQ(acked, kSize);
}

// No DRM master lands the flip before the swap is asked for.
TEST_F(DrmCanvasTest, ASwapAfterItsFlipLandedIsAcknowledgedAtOnce) {
  std::optional<gfx::Size> acked;
  Present(gfx::Rect(kSize), SK_ColorRED);
  Land(0);
  canvas_.OnSwapBuffers(
      base::BindOnce([](std::optional<gfx::Size>* acked,
                        const gfx::Size& size) { *acked = size; },
                     &acked),
      gfx::FrameData());

  EXPECT_EQ(acked, kSize);
}

// The window moved to another card; buffers from the old one cannot scan out.
TEST_F(DrmCanvasTest, ANewDeviceGetsNewBuffersAndTheWholeFrame) {
  Present(gfx::Rect(kSize), SK_ColorRED);
  Land(0, gfx::SwapResult::SWAP_NAK_RECREATE_BUFFERS);
  Present(gfx::Rect(0, 0, 2, 2), SK_ColorBLUE);

  ASSERT_EQ(seen_.buffers.size(), 4u);
  EXPECT_EQ(seen_.flips[1].framebuffer, seen_.framebuffers[2]);
  EXPECT_EQ(PixelOf(2, 1, 1), SK_ColorBLUE);
  EXPECT_EQ(PixelOf(2, 5, 3), SK_ColorRED);
}

TEST_F(DrmCanvasTest, AResizeAllocatesAtTheNewSize) {
  canvas_.ResizeCanvas(gfx::Size(16, 8), 1.f);
  Present(gfx::Rect(0, 0, 16, 8), SK_ColorRED);

  ASSERT_EQ(seen_.buffers.size(), 4u);
  EXPECT_EQ(seen_.framebuffers[2]->size(), gfx::Size(16, 8));
  EXPECT_EQ(seen_.flips[0].framebuffer, seen_.framebuffers[2]);
}

}  // namespace
}  // namespace ui
