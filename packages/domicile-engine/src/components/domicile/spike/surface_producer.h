// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_SPIKE_SURFACE_PRODUCER_H_
#define COMPONENTS_DOMICILE_SPIKE_SURFACE_PRODUCER_H_

#include <cstdint>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/time/time.h"
#include "components/domicile/mojom/frame_sink_broker.mojom.h"
#include "components/domicile/spike/mojom/spike_probe.mojom.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "components/viz/common/frame_timing_details_map.h"
#include "components/viz/common/quads/compositor_frame.h"
#include "components/viz/common/resources/returned_resource.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/local_surface_id.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/platform/named_platform_channel.h"
#include "services/viz/public/mojom/compositing/compositor_frame_sink.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/geometry/size.h"

namespace domicile::spike {

// Spike only: a viz client in a process the browser did not launch, standing
// in for domicile-compositor. See docs/architecture/ENGINE-FORK.md.
//
// Joins the browser's mojo graph over a named socket, gets a frame sink from
// domicile::FrameSinkBroker, and submits solid-color CompositorFrames to
// whichever surface a page embeds it at. The embedder allocates the
// LocalSurfaceId and this adopts it, as with RemoteFrame. The caller checks the
// result.
class SurfaceProducer : public viz::mojom::CompositorFrameSinkClient,
                        public mojom::SurfaceObserver {
 public:
  // Runs with the surface and size an embedder assigned, and again whenever
  // the embedder's box changes.
  using EmbeddedCallback =
      base::RepeatingCallback<void(const viz::LocalSurfaceId&,
                                   const gfx::Size&)>;
  // Runs once if the browser drops the connection.
  using LostCallback = base::OnceCallback<void(const std::string& why)>;

  SurfaceProducer(SkColor color,
                  EmbeddedCallback on_embedded,
                  LostCallback on_lost);

  SurfaceProducer(const SurfaceProducer&) = delete;
  SurfaceProducer& operator=(const SurfaceProducer&) = delete;

  ~SurfaceProducer() override;

  // Joins the browser's mojo graph and takes the broker and probe pipes off the
  // invitation.
  //
  // Uses a named-socket invitation, not a mojo::IsolatedConnection: the broker
  // forwards the CompositorFrameSink receiver to the viz process, and an
  // isolated connection's handles cannot pass to a third process. See
  // docs/architecture/ENGINE-FORK.md#how-the-producer-reaches-the-broker.
  bool Connect(const mojo::NamedPlatformChannel::ServerName& socket);

  // Asks the broker for a frame sink and runs `on_brokered` with the id it
  // allocated. Nothing is submitted until an embedder names a surface, which
  // may happen before or after this.
  using BrokeredCallback = base::OnceCallback<void(const viz::FrameSinkId&)>;
  void Start(BrokeredCallback on_brokered);

  // Sets the fill color and submits a frame at once, so latency can be timed
  // from this call. Only stores the color before a surface is embedded.
  void SetColor(SkColor color);

  SkColor color() const { return color_; }
  const viz::FrameSinkId& frame_sink_id() const { return frame_sink_id_; }
  const gfx::Size& size() const { return size_; }
  bool embedded() const { return submitting_; }
  int frames_submitted() const { return frames_submitted_; }
  int begin_frames_seen() const { return begin_frames_seen_; }

  // The display's frame interval from the last BeginFrameArgs, or zero before
  // the first BeginFrame. Used to express latency in frames.
  base::TimeDelta frame_interval() const { return frame_interval_; }

  // Reads back what viz drew. Valid after Connect.
  mojom::SpikeProbe* probe() { return probe_.get(); }

 private:
  // mojom::SurfaceObserver:
  // Ignores `scale` and `zoom`: the spike renders in the page's pixels.
  void OnSurfaceEmbedded(const viz::LocalSurfaceId& local_surface_id,
                         const gfx::Size& size,
                         double scale,
                         double zoom) override;
  // Sent only to producers whose sink the browser owns. This one holds its
  // own sink, so it is a no-op.
  void OnBufferReleased(uint64_t buffer_id) override;

  // viz::mojom::CompositorFrameSinkClient:
  void DidReceiveCompositorFrameAck(
      std::vector<viz::ReturnedResource> resources) override;
  void OnBeginFrame(const viz::BeginFrameArgs& args,
                    const viz::FrameTimingDetailsMap& timing_details,
                    std::vector<viz::ReturnedResource> resources) override;
  void OnBeginFramePausedChanged(bool paused) override;
  void ReclaimResources(std::vector<viz::ReturnedResource> resources) override;
  void OnCompositorFrameTransitionDirectiveProcessed(
      uint32_t sequence_id) override;
  void OnSurfaceEvicted(const viz::LocalSurfaceId& local_surface_id) override;

  void OnFrameSinkCreated(BrokeredCallback on_brokered,
                          const viz::FrameSinkId& frame_sink_id);
  void OnBrokerDisconnected();
  void Submit(const viz::BeginFrameAck& ack);

  SkColor color_;
  EmbeddedCallback on_embedded_;
  LostCallback on_lost_;

  mojo::Remote<mojom::FrameSinkBroker> broker_;
  mojo::Remote<mojom::SpikeProbe> probe_;
  mojo::Remote<viz::mojom::CompositorFrameSink> sink_;
  mojo::Receiver<viz::mojom::CompositorFrameSinkClient> client_receiver_{this};
  mojo::Receiver<mojom::SurfaceObserver> observer_receiver_{this};

  viz::FrameSinkId frame_sink_id_;
  viz::LocalSurfaceId local_surface_id_;
  gfx::Size size_;
  viz::FrameTokenGenerator next_frame_token_;
  bool submitting_ = false;
  int frames_submitted_ = 0;
  int begin_frames_seen_ = 0;
  base::TimeDelta frame_interval_;
};

}  // namespace domicile::spike

#endif  // COMPONENTS_DOMICILE_SPIKE_SURFACE_PRODUCER_H_
