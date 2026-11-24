// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/display_capture.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/read_only_shared_memory_region.h"
#include "base/run_loop.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/video_capture_target.h"
#include "media/base/video_types.h"
#include "media/capture/mojom/video_capture_buffer.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/viz/privileged/mojom/compositing/frame_sink_video_capture.mojom.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {
namespace {

constexpr viz::FrameSinkId kDisplayRoot(0u, 7u);
constexpr gfx::Size kSize(1920, 1080);
constexpr uint32_t kMaxFps = 30;

// DRM_FORMAT_ARGB8888 and DRM_FORMAT_ABGR8888.
constexpr uint32_t kArgb8888 = 0x34325241;
constexpr uint32_t kAbgr8888 = 0x34324241;

// Viz's capturer, recording what it was asked.
class FakeCapturer : public viz::mojom::FrameSinkVideoCapturer {
 public:
  void Bind(mojo::PendingReceiver<viz::mojom::FrameSinkVideoCapturer> pipe) {
    receiver_.Bind(std::move(pipe));
  }

  // viz::mojom::FrameSinkVideoCapturer implementation.
  void SetFormat(media::VideoPixelFormat format) override { format_ = format; }
  void SetMinCapturePeriod(base::TimeDelta min_period) override {
    min_period_ = min_period;
  }
  void SetMinSizeChangePeriod(base::TimeDelta min_period) override {}
  void SetResolutionConstraints(const gfx::Size& min_size,
                                const gfx::Size& max_size,
                                bool use_fixed_aspect_ratio) override {
    min_size_ = min_size;
    max_size_ = max_size;
    fixed_aspect_ = use_fixed_aspect_ratio;
  }
  void SetAutoThrottlingEnabled(bool enabled) override {}
  void SetAnimationFpsLockIn(bool enabled,
                             float majority_damaged_pixel_min_ratio) override {}
  void SetIsSecure(bool secure) override {}
  void ChangeTarget(const std::optional<viz::VideoCaptureTarget>& target,
                    uint32_t sub_capture_version) override {
    target_ = target;
  }
  void Start(mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumer> consumer,
             viz::mojom::BufferFormatPreference preference) override {
    consumer_.reset();
    consumer_.Bind(std::move(consumer));
    preference_ = preference;
  }
  void Stop() override {}
  void RequestRefreshFrame() override {}
  void InvalidateBuffers() override {}
  void CreateOverlay(
      int32_t stacking_index,
      mojo::PendingReceiver<viz::mojom::FrameSinkVideoCaptureOverlay> receiver)
      override {}

  std::optional<media::VideoPixelFormat> format_;
  std::optional<base::TimeDelta> min_period_;
  gfx::Size min_size_;
  gfx::Size max_size_;
  bool fixed_aspect_ = false;
  std::optional<viz::VideoCaptureTarget> target_;
  std::optional<viz::mojom::BufferFormatPreference> preference_;
  mojo::Remote<viz::mojom::FrameSinkVideoConsumer> consumer_;

 private:
  mojo::Receiver<viz::mojom::FrameSinkVideoCapturer> receiver_{this};
};

// The callbacks viz hands with each frame, recording whether it came back.
class FakeFrameCallbacks
    : public viz::mojom::FrameSinkVideoConsumerFrameCallbacks {
 public:
  mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>
  BindRemote() {
    return receiver_.BindNewPipeAndPassRemote();
  }

  // viz::mojom::FrameSinkVideoConsumerFrameCallbacks implementation.
  void Done() override { done_ = true; }
  void ProvideFeedback(const media::VideoCaptureFeedback& feedback) override {}

  bool done_ = false;

 private:
  mojo::Receiver<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> receiver_{
      this};
};

// The producer's observer, keeping each frame and its hold, and why the
// browser closed it.
class FakeObserver : public mojom::DisplayCaptureObserver {
 public:
  mojo::PendingRemote<mojom::DisplayCaptureObserver> BindRemote() {
    mojo::PendingRemote<mojom::DisplayCaptureObserver> remote =
        receiver_.BindNewPipeAndPassRemote();
    receiver_.set_disconnect_with_reason_handler(base::BindOnce(
        [](std::optional<std::string>* why, uint32_t,
           const std::string& description) { *why = description; },
        &why_));
    return remote;
  }

  // mojom::DisplayCaptureObserver implementation.
  void OnFrameCaptured(
      mojom::CapturedFramePtr frame,
      mojo::PendingRemote<mojom::CapturedFrameHold> hold) override {
    frames_.push_back(std::move(frame));
    holds_.emplace_back(std::move(hold));
  }

  std::vector<mojom::CapturedFramePtr> frames_;
  std::vector<mojo::Remote<mojom::CapturedFrameHold>> holds_;
  std::optional<std::string> why_;

 private:
  mojo::Receiver<mojom::DisplayCaptureObserver> receiver_{this};
};

}  // namespace

class DisplayCaptureTest : public testing::Test {
 protected:
  void Start(bool gpu) {
    capture_ = std::make_unique<DisplayCapture>(
        base::BindRepeating(&FakeCapturer::Bind,
                            base::Unretained(&capturer_)),
        kDisplayRoot, kSize, kMaxFps, gpu,
        control_.BindNewPipeAndPassReceiver(), observer_.BindRemote(),
        base::BindOnce([](bool* ended) { *ended = true; }, &ended_));
    control_.set_disconnect_with_reason_handler(base::BindOnce(
        [](std::optional<std::string>* why, uint32_t,
           const std::string& description) { *why = description; },
        &control_why_));
    base::RunLoop().RunUntilIdle();
  }

  // Sends a frame of `kSize` in shared memory, as viz does when it
  // composites in software.
  void SendShmFrame(media::VideoPixelFormat format,
                    std::optional<gfx::Rect> update) {
    base::MappedReadOnlyRegion memory =
        base::ReadOnlySharedMemoryRegion::Create(
            static_cast<size_t>(kSize.GetArea()) * 4);
    ASSERT_TRUE(memory.IsValid());
    media::mojom::VideoFrameInfoPtr info = media::mojom::VideoFrameInfo::New();
    info->pixel_format = format;
    info->coded_size = kSize;
    info->visible_rect = gfx::Rect(kSize);
    info->natural_size = kSize;
    info->metadata.capture.update_rect = update;
    capturer_.consumer_->OnFrameCaptured(
        media::mojom::VideoBufferHandle::NewReadOnlyShmemRegion(
            std::move(memory.region)),
        std::move(info), gfx::Rect(0, 0, 1920, 1000),
        callbacks_.BindRemote());
    base::RunLoop().RunUntilIdle();
  }

  base::test::SingleThreadTaskEnvironment task_environment_;
  FakeCapturer capturer_;
  FakeFrameCallbacks callbacks_;
  FakeObserver observer_;
  mojo::Remote<mojom::DisplayCapture> control_;
  std::optional<std::string> control_why_;
  bool ended_ = false;
  std::unique_ptr<DisplayCapture> capture_;
};

TEST_F(DisplayCaptureTest, CapturesTheRootFrameSinkAtTheSizeAndRateAsked) {
  Start(/*gpu=*/false);

  EXPECT_EQ(capturer_.format_, media::PIXEL_FORMAT_ARGB);
  EXPECT_EQ(capturer_.min_period_, base::Seconds(1) / 30);
  EXPECT_EQ(capturer_.min_size_, kSize);
  EXPECT_EQ(capturer_.max_size_, kSize);
  EXPECT_TRUE(capturer_.fixed_aspect_);
  ASSERT_TRUE(capturer_.target_.has_value());
  EXPECT_EQ(capturer_.target_->frame_sink_id, kDisplayRoot);
  EXPECT_EQ(capturer_.preference_, viz::mojom::BufferFormatPreference::kDefault);
}

TEST_F(DisplayCaptureTest, AGpuBrowserAsksForDmabufs) {
  Start(/*gpu=*/true);

  EXPECT_EQ(capturer_.preference_,
            viz::mojom::BufferFormatPreference::
                kPreferSharedImageWithNativeHandle);
}

TEST_F(DisplayCaptureTest, AFrameReachesTheProducerWithItsLayoutAndDamage) {
  Start(/*gpu=*/false);

  SendShmFrame(media::PIXEL_FORMAT_ARGB, gfx::Rect(10, 20, 30, 40));

  ASSERT_EQ(observer_.frames_.size(), 1u);
  const mojom::CapturedFramePtr& frame = observer_.frames_[0];
  EXPECT_TRUE(frame->pixels->is_shm());
  EXPECT_EQ(frame->fourcc, kArgb8888);
  EXPECT_EQ(frame->size, kSize);
  EXPECT_EQ(frame->stride, 1920u * 4);
  EXPECT_EQ(frame->content, gfx::Rect(0, 0, 1920, 1000));
  EXPECT_EQ(frame->damage, gfx::Rect(10, 20, 30, 40));
}

TEST_F(DisplayCaptureTest, AFrameWithNoUpdateRectDamagesEverything) {
  Start(/*gpu=*/false);

  SendShmFrame(media::PIXEL_FORMAT_ABGR, std::nullopt);

  ASSERT_EQ(observer_.frames_.size(), 1u);
  EXPECT_EQ(observer_.frames_[0]->fourcc, kAbgr8888);
  EXPECT_TRUE(observer_.frames_[0]->damage.IsEmpty());
}

TEST_F(DisplayCaptureTest, ClosingTheHoldGivesTheBufferBackToViz) {
  Start(/*gpu=*/false);
  SendShmFrame(media::PIXEL_FORMAT_ARGB, std::nullopt);
  ASSERT_EQ(observer_.holds_.size(), 1u);
  EXPECT_FALSE(callbacks_.done_);

  observer_.holds_[0].reset();
  base::RunLoop().RunUntilIdle();

  EXPECT_TRUE(callbacks_.done_);
}

TEST_F(DisplayCaptureTest, AResizeChangesTheCapturedSize) {
  Start(/*gpu=*/false);

  control_->Resize(gfx::Size(1280, 720));
  base::RunLoop().RunUntilIdle();

  EXPECT_EQ(capturer_.min_size_, gfx::Size(1280, 720));
  EXPECT_EQ(capturer_.max_size_, gfx::Size(1280, 720));
}

TEST_F(DisplayCaptureTest, ClosingTheControlEndsTheCapture) {
  Start(/*gpu=*/false);
  EXPECT_FALSE(ended_);

  control_.reset();
  base::RunLoop().RunUntilIdle();

  EXPECT_TRUE(ended_);
}

TEST_F(DisplayCaptureTest, VizStoppingBeforeAFrameSaysItCouldNotAllocateOne) {
  Start(/*gpu=*/true);

  capturer_.consumer_->OnStopped();
  base::RunLoop().RunUntilIdle();

  EXPECT_TRUE(ended_);
  const std::string why =
      "viz stopped the capture before its first frame: it could not "
      "allocate a dmabuf to capture into";
  EXPECT_EQ(observer_.why_, why);
  EXPECT_EQ(control_why_, why);
}

TEST_F(DisplayCaptureTest, VizStoppingAfterAFrameSaysSo) {
  Start(/*gpu=*/false);
  SendShmFrame(media::PIXEL_FORMAT_ARGB, std::nullopt);

  capturer_.consumer_->OnStopped();
  base::RunLoop().RunUntilIdle();

  EXPECT_TRUE(ended_);
  EXPECT_EQ(observer_.why_, "viz stopped the capture");
}

TEST(CapturedFourccTest, NamesTheFourByteFormatsViz) {
  EXPECT_EQ(CapturedFourcc(media::PIXEL_FORMAT_ARGB), kArgb8888);
  EXPECT_EQ(CapturedFourcc(media::PIXEL_FORMAT_ABGR), kAbgr8888);
  EXPECT_EQ(CapturedFourcc(media::PIXEL_FORMAT_XRGB), 0x34325258u);
  EXPECT_EQ(CapturedFourcc(media::PIXEL_FORMAT_XBGR), 0x34324258u);
  EXPECT_FALSE(CapturedFourcc(media::PIXEL_FORMAT_I420).has_value());
}

}  // namespace domicile
