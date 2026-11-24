// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_DISPLAY_CAPTURE_H_
#define COMPONENTS_DOMICILE_BROWSER_DISPLAY_CAPTURE_H_

#include <cstdint>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "components/domicile/mojom/frame_sink_broker.mojom.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/host/client_frame_sink_video_capturer.h"
#include "media/base/capture_version.h"
#include "media/base/video_types.h"
#include "media/capture/mojom/video_capture_buffer.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/viz/privileged/mojom/compositing/frame_sink_video_capture.mojom.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {

// The DRM fourcc of a frame viz captured in `format`, or nullopt for a format
// the producer cannot read.
std::optional<uint32_t> CapturedFourcc(media::VideoPixelFormat format);

// One display capture: a viz FrameSinkVideoCapturer on a display's root frame
// sink, its frames relayed to the producer.
//
// Viz sends frames only on damage, at most `max_fps` a second. Each frame's
// buffer goes back to viz when the producer closes its `CapturedFrameHold`.
// See docs/PORTALS.md in the Domicile repository.
class DisplayCapture : public mojom::DisplayCapture,
                       public viz::mojom::FrameSinkVideoConsumer {
 public:
  // Makes the capturer in viz. Injected so tests need no viz.
  using Connect =
      viz::ClientFrameSinkVideoCapturer::EstablishConnectionCallback;

  // `gpu` asks viz for dmabufs; otherwise frames come in shared memory.
  // `ended` runs once the producer closes either pipe; the owner then
  // destroys this.
  DisplayCapture(Connect connect,
                 const viz::FrameSinkId& target,
                 const gfx::Size& size,
                 uint32_t max_fps,
                 bool gpu,
                 mojo::PendingReceiver<mojom::DisplayCapture> control,
                 mojo::PendingRemote<mojom::DisplayCaptureObserver> observer,
                 base::OnceClosure ended);

  DisplayCapture(const DisplayCapture&) = delete;
  DisplayCapture& operator=(const DisplayCapture&) = delete;

  ~DisplayCapture() override;

  // mojom::DisplayCapture implementation.
  void Resize(const gfx::Size& size) override;

 private:
  // viz::mojom::FrameSinkVideoConsumer implementation.
  void OnFrameCaptured(
      media::mojom::VideoBufferHandlePtr data,
      media::mojom::VideoFrameInfoPtr info,
      const gfx::Rect& content_rect,
      mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks>
          callbacks) override;
  void OnNewCaptureVersion(
      const media::CaptureVersion& capture_version) override {}
  void OnFrameWithEmptyRegionCapture() override {}
  // Viz stops a capture it cannot go on with, such as one whose first frame
  // it could not allocate.
  void OnStopped() override;
  // WebRTC's diagnostic log of each capture step. Viz reports failures
  // through OnStopped, not here.
  void OnLog(const std::string& message) override {}

  // Stops the capture and tells the owner. A `why` that is not empty, for an
  // ending the producer did not choose, is logged and closes both pipes with
  // it as the reason.
  void End(const std::string& why);

  viz::ClientFrameSinkVideoCapturer capturer_;
  mojo::Receiver<mojom::DisplayCapture> control_;
  mojo::Remote<mojom::DisplayCaptureObserver> observer_;
  base::OnceClosure ended_;
  const bool gpu_;
  bool captured_ = false;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_DISPLAY_CAPTURE_H_
