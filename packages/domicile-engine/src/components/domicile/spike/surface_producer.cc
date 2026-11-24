// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/spike/surface_producer.h"

#include <optional>
#include <utility>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "components/viz/common/quads/compositor_render_pass.h"
#include "components/viz/common/quads/solid_color_draw_quad.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/platform/platform_channel_endpoint.h"
#include "mojo/public/cpp/system/invitation.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/transform.h"

namespace domicile::spike {
namespace {

// Must match content/browser/domicile/domicile_frame_sink_broker.cc. Names are
// integers because ipcz indexes an attachment by the first four bytes of its
// name, so string names all collide on index 0.
constexpr uint64_t kBrokerPipeName = 0;
constexpr uint64_t kProbePipeName = 1;

}  // namespace

SurfaceProducer::SurfaceProducer(SkColor color,
                                 EmbeddedCallback on_embedded,
                                 LostCallback on_lost)
    : color_(color),
      on_embedded_(std::move(on_embedded)),
      on_lost_(std::move(on_lost)) {}

SurfaceProducer::~SurfaceProducer() = default;

bool SurfaceProducer::Connect(
    const mojo::NamedPlatformChannel::ServerName& socket) {
  mojo::PlatformChannelEndpoint endpoint =
      mojo::NamedPlatformChannel::ConnectToServer(socket);
  if (!endpoint.is_valid()) {
    LOG(ERROR) << "no server at " << socket;
    return false;
  }

  mojo::IncomingInvitation invitation =
      mojo::IncomingInvitation::Accept(std::move(endpoint));
  if (!invitation.is_valid()) {
    LOG(ERROR) << "invitation refused";
    return false;
  }

  broker_.Bind(mojo::PendingRemote<mojom::FrameSinkBroker>(
      invitation.ExtractMessagePipe(kBrokerPipeName), 0));
  probe_.Bind(mojo::PendingRemote<mojom::SpikeProbe>(
      invitation.ExtractMessagePipe(kProbePipeName), 0));
  broker_.set_disconnect_handler(base::BindOnce(
      &SurfaceProducer::OnBrokerDisconnected, base::Unretained(this)));
  return true;
}

void SurfaceProducer::Start(BrokeredCallback on_brokered) {
  mojo::PendingRemote<viz::mojom::CompositorFrameSinkClient> client;
  client_receiver_.Bind(client.InitWithNewPipeAndPassReceiver());
  broker_->CreateFrameSink(
      std::move(client), sink_.BindNewPipeAndPassReceiver(),
      observer_receiver_.BindNewPipeAndPassRemote(), "domicile-spike",
      base::BindOnce(&SurfaceProducer::OnFrameSinkCreated,
                     base::Unretained(this), std::move(on_brokered)));
}

void SurfaceProducer::SetColor(SkColor color) {
  color_ = color;
  if (submitting_) {
    Submit(viz::BeginFrameAck::CreateManualAckWithDamage());
  }
}

void SurfaceProducer::OnFrameSinkCreated(
    BrokeredCallback on_brokered,
    const viz::FrameSinkId& frame_sink_id) {
  frame_sink_id_ = frame_sink_id;
  std::move(on_brokered).Run(frame_sink_id);
}

// The embedder allocates the LocalSurfaceId, including its embed_token, and
// sets the size from its layout box. The producer adopts both.
void SurfaceProducer::OnSurfaceEmbedded(
    const viz::LocalSurfaceId& local_surface_id,
    const gfx::Size& size,
    double scale,
    double zoom) {
  const bool first = !submitting_;
  local_surface_id_ = local_surface_id;
  size_ = size;
  submitting_ = true;

  // Submit now so the surface activates without waiting for a BeginFrame. On
  // a resize this makes the new id current before anyone samples the window.
  Submit(viz::BeginFrameAck::CreateManualAckWithDamage());
  if (first) {
    sink_->SetNeedsBeginFrame(true);
  }

  on_embedded_.Run(local_surface_id, size);
}

void SurfaceProducer::OnBufferReleased(uint64_t buffer_id) {}

void SurfaceProducer::Submit(const viz::BeginFrameAck& ack) {
  const gfx::Rect rect(size_);

  auto pass = viz::CompositorRenderPass::Create();
  pass->SetNew(viz::CompositorRenderPassId{1}, rect, rect, gfx::Transform());

  viz::SharedQuadState* quad_state = pass->CreateAndAppendSharedQuadState();
  quad_state->SetAll(gfx::Transform(),
                     /*layer_rect=*/rect,
                     /*visible_layer_rect=*/rect,
                     /*filter_info=*/gfx::MaskFilterInfo(),
                     /*clip=*/std::nullopt,
                     /*contents_opaque=*/true,
                     /*opacity_f=*/1.f,
                     /*blend=*/SkBlendMode::kSrcOver,
                     /*sorting_context=*/0,
                     /*layer_id=*/0u,
                     /*fast_rounded_corner=*/false);

  viz::SolidColorDrawQuad* quad =
      pass->CreateAndAppendDrawQuad<viz::SolidColorDrawQuad>();
  quad->SetNew(quad_state, rect, rect, SkColor4f::FromColor(color_),
               /*anti_aliasing_off=*/false);

  viz::CompositorFrame frame;
  frame.metadata.begin_frame_ack = ack;
  frame.metadata.device_scale_factor = 1.f;
  frame.metadata.frame_token = ++next_frame_token_;
  frame.render_pass_list.push_back(std::move(pass));

  sink_->SubmitCompositorFrame(local_surface_id_, std::move(frame),
                               /*hit_test_region_list=*/std::nullopt,
                               /*submit_time=*/0);
  ++frames_submitted_;
}

void SurfaceProducer::OnBrokerDisconnected() {
  if (on_lost_) {
    std::move(on_lost_).Run("the browser dropped the broker connection");
  }
}

void SurfaceProducer::DidReceiveCompositorFrameAck(
    std::vector<viz::ReturnedResource> resources) {}

void SurfaceProducer::OnBeginFrame(
    const viz::BeginFrameArgs& args,
    const viz::FrameTimingDetailsMap& timing_details,
    std::vector<viz::ReturnedResource> resources) {
  ++begin_frames_seen_;
  frame_interval_ = args.interval;
  if (!submitting_) {
    return;
  }
  Submit(viz::BeginFrameAck(args, true));
}

void SurfaceProducer::OnBeginFramePausedChanged(bool paused) {}

void SurfaceProducer::ReclaimResources(
    std::vector<viz::ReturnedResource> resources) {}

void SurfaceProducer::OnCompositorFrameTransitionDirectiveProcessed(
    uint32_t sequence_id) {}

void SurfaceProducer::OnSurfaceEvicted(
    const viz::LocalSurfaceId& local_surface_id) {}

}  // namespace domicile::spike
