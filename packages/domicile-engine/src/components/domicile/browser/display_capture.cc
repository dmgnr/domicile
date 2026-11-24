// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/display_capture.h"

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/time/time.h"
#include "components/viz/common/surfaces/video_capture_target.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"

namespace domicile {
namespace {

// The bytes per pixel of every format `CapturedFourcc` names.
constexpr uint32_t kBytesPerPixel = 4;

// The reason code both pipes close with when the capture failed. The
// description says why.
constexpr uint32_t kCaptureFailed = 1;

// Holds one frame's buffer for the producer. Closing the producer's end
// destroys this, which gives the buffer back to viz.
class FrameHold : public mojom::CapturedFrameHold {
 public:
  explicit FrameHold(
      mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>
          callbacks)
      : callbacks_(std::move(callbacks)) {}

  FrameHold(const FrameHold&) = delete;
  FrameHold& operator=(const FrameHold&) = delete;

  ~FrameHold() override { callbacks_->Done(); }

 private:
  mojo::Remote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> callbacks_;
};

}  // namespace

std::optional<uint32_t> CapturedFourcc(media::VideoPixelFormat format) {
  // media's names are the little-endian word, DRM's the byte order read
  // backwards, so ARGB is ARGB8888 in both.
  switch (format) {
    case media::PIXEL_FORMAT_ARGB:
      return 0x34325241;  // DRM_FORMAT_ARGB8888
    case media::PIXEL_FORMAT_ABGR:
      return 0x34324241;  // DRM_FORMAT_ABGR8888
    case media::PIXEL_FORMAT_XRGB:
      return 0x34325258;  // DRM_FORMAT_XRGB8888
    case media::PIXEL_FORMAT_XBGR:
      return 0x34324258;  // DRM_FORMAT_XBGR8888
    default:
      return std::nullopt;
  }
}

DisplayCapture::DisplayCapture(
    Connect connect,
    const viz::FrameSinkId& target,
    const gfx::Size& size,
    uint32_t max_fps,
    bool gpu,
    mojo::PendingReceiver<mojom::DisplayCapture> control,
    mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
    base::OnceClosure ended)
    : capturer_(std::move(connect)),
      control_(this, std::move(control)),
      observer_(std::move(observer)),
      ended_(std::move(ended)),
      gpu_(gpu) {
  // Unretained: both pipes are members, so neither handler outlives this.
  control_.set_disconnect_handler(base::BindOnce(
      &DisplayCapture::End, base::Unretained(this), std::string()));
  observer_.set_disconnect_handler(base::BindOnce(
      &DisplayCapture::End, base::Unretained(this), std::string()));

  // ARGB is the one RGB format viz hands out as a dmabuf; the frame says
  // whether it came out BGRA or RGBA.
  capturer_.SetFormat(media::PIXEL_FORMAT_ARGB);
  capturer_.SetMinCapturePeriod(base::Seconds(1) /
                                static_cast<int64_t>(max_fps));
  // A stream changes size only when the producer says so.
  capturer_.SetMinSizeChangePeriod(base::TimeDelta());
  capturer_.SetResolutionConstraints(size, size,
                                     /*use_fixed_aspect_ratio=*/true);
  capturer_.SetAutoThrottlingEnabled(false);
  capturer_.ChangeTarget(viz::VideoCaptureTarget(target),
                         /*sub_capture_target_version=*/0);
  capturer_.Start(this, gpu ? viz::mojom::BufferFormatPreference::
                                  kPreferSharedImageWithNativeHandle
                            : viz::mojom::BufferFormatPreference::kDefault);
}

DisplayCapture::~DisplayCapture() = default;

void DisplayCapture::Resize(const gfx::Size& size) {
  if (size.IsEmpty()) {
    control_.ReportBadMessage("A display capture cannot be empty");
    End("the producer asked for an empty size");
    return;
  }
  capturer_.SetResolutionConstraints(size, size,
                                     /*use_fixed_aspect_ratio=*/true);
}

void DisplayCapture::OnFrameCaptured(
    media::mojom::VideoBufferHandlePtr data,
    media::mojom::VideoFrameInfoPtr info,
    const gfx::Rect& content_rect,
    mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>
        callbacks) {
  captured_ = true;
  const std::optional<uint32_t> fourcc = CapturedFourcc(info->pixel_format);
  if (!fourcc.has_value()) {
    End("viz captured a format the producer cannot read, media pixel format " +
        base::NumberToString(static_cast<int>(info->pixel_format)));
    return;
  }

  mojom::CapturedPixelsPtr pixels;
  uint32_t stride = 0;
  if (data->is_gpu_memory_buffer_handle()) {
    pixels = mojom::CapturedPixels::NewDmabuf(
        std::move(data->get_gpu_memory_buffer_handle()));
  } else if (data->is_read_only_shmem_region()) {
    pixels = mojom::CapturedPixels::NewShm(
        std::move(data->get_read_only_shmem_region()));
    // SharedMemoryVideoFramePool packs rows with no padding.
    stride = static_cast<uint32_t>(info->coded_size.width()) * kBytesPerPixel;
  } else {
    End("viz captured into a buffer that is neither a dmabuf nor shared "
        "memory");
    return;
  }

  // An absent or empty update rect is a refresh; the producer redraws all.
  const gfx::Rect damage =
      info->metadata.capture.update_rect.value_or(gfx::Rect());

  mojo::PendingRemote<mojom::CapturedFrameHold> hold;
  mojo::MakeSelfOwnedReceiver(std::make_unique<FrameHold>(std::move(callbacks)),
                              hold.InitWithNewPipeAndPassReceiver());
  observer_->OnFrameCaptured(
      mojom::CapturedFrame::New(std::move(pixels), *fourcc, info->coded_size,
                                stride, content_rect, damage),
      std::move(hold));
}

void DisplayCapture::OnStopped() {
  if (captured_) {
    End("viz stopped the capture");
    return;
  }
  End(std::string("viz stopped the capture before its first frame: it could "
                  "not allocate ") +
      (gpu_ ? "a dmabuf" : "shared memory") + " to capture into");
}

void DisplayCapture::End(const std::string& why) {
  if (!why.empty()) {
    LOG(ERROR) << "domicile: a display capture stopped: " << why;
    control_.ResetWithReason(kCaptureFailed, why);
    observer_.ResetWithReason(kCaptureFailed, why);
  }
  capturer_.StopAndResetConsumer();
  // Runs last: the owner destroys this.
  std::move(ended_).Run();
}

}  // namespace domicile
