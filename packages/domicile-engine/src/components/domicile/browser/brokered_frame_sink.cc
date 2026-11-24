// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/brokered_frame_sink.h"

#include <memory>
#include <optional>
#include <ostream>
#include <utility>

#include "base/logging.h"
#include "base/time/time.h"
#include "components/viz/common/quads/compositor_frame.h"
#include "components/viz/common/quads/compositor_render_pass.h"
#include "components/viz/common/quads/texture_draw_quad.h"
#include "components/viz/common/surfaces/surface_info.h"
#include "components/viz/host/host_frame_sink_manager.h"
#include "gpu/command_buffer/client/client_shared_image.h"
#include "gpu/command_buffer/client/shared_image_interface.h"
#include "gpu/command_buffer/common/shared_image_usage.h"
#include "gpu/command_buffer/common/sync_token.h"
#include "third_party/skia/include/core/SkAlphaType.h"
#include "third_party/skia/include/gpu/ganesh/GrTypes.h"
#include "ui/gfx/color_space.h"
#include "ui/gfx/geometry/transform.h"
#include "ui/gfx/gpu_fence.h"

namespace domicile {
namespace {

// Window buffers are only sampled by the display compositor.
//
// Not SCANOUT: a SharedImage may claim it only if the buffer was allocated for
// scanout, and gbm on a render node without KMS refuses that (seen on crux's
// NVIDIA backend). A SharedImage that claims it anyway is never drawn.
constexpr gpu::SharedImageUsageSet kWindowUsage =
    gpu::SHARED_IMAGE_USAGE_DISPLAY_READ;

// A viz format and the alpha its pixels carry.
struct ImportFormat {
  viz::SharedImageFormat format;
  SkAlphaType alpha;
};

// Maps a DRM fourcc to the matching viz format.
//
// A mismatch does not fail; it draws the window with permuted channels. DRM
// names channels from the most significant bit and viz in memory order, so
// ARGB8888 is BGRA_8888. Viz has no 10-bit or half-float format without
// alpha, and its twin with alpha, even marked opaque, draws the padding bits
// as alpha: a window of zeroed padding comes out transparent. Those formats
// are refused; the compositor copies a wl_shm frame in one into its twin.
std::optional<ImportFormat> FormatFromFourcc(uint32_t fourcc) {
  switch (fourcc) {
    case 0x34325241:  // DRM_FORMAT_ARGB8888
      return ImportFormat{viz::SinglePlaneFormat::kBGRA_8888,
                          kPremul_SkAlphaType};
    case 0x34325258:  // DRM_FORMAT_XRGB8888
      return ImportFormat{viz::SinglePlaneFormat::kBGRX_8888,
                          kOpaque_SkAlphaType};
    case 0x34324241:  // DRM_FORMAT_ABGR8888
      return ImportFormat{viz::SinglePlaneFormat::kRGBA_8888,
                          kPremul_SkAlphaType};
    case 0x34324258:  // DRM_FORMAT_XBGR8888
      return ImportFormat{viz::SinglePlaneFormat::kRGBX_8888,
                          kOpaque_SkAlphaType};
    case 0x30335241:  // DRM_FORMAT_ARGB2101010
      return ImportFormat{viz::SinglePlaneFormat::kBGRA_1010102,
                          kPremul_SkAlphaType};
    case 0x30334241:  // DRM_FORMAT_ABGR2101010
      return ImportFormat{viz::SinglePlaneFormat::kRGBA_1010102,
                          kPremul_SkAlphaType};
    case 0x48344241:  // DRM_FORMAT_ABGR16161616F
      return ImportFormat{viz::SinglePlaneFormat::kRGBA_F16,
                          kPremul_SkAlphaType};
    default:
      return std::nullopt;
  }
}

}  // namespace

BrokeredFrameSink::ImportedBuffer::ImportedBuffer() = default;
BrokeredFrameSink::ImportedBuffer::ImportedBuffer(ImportedBuffer&&) = default;
BrokeredFrameSink::ImportedBuffer&
BrokeredFrameSink::ImportedBuffer::operator=(ImportedBuffer&&) = default;
BrokeredFrameSink::ImportedBuffer::~ImportedBuffer() = default;

BrokeredFrameSink::BrokeredFrameSink(
    viz::HostFrameSinkManager* host_frame_sink_manager,
    const viz::FrameSinkId& frame_sink_id,
    mojo::PendingRemote<mojom::SurfaceObserver> observer,
    mojo::ReceiverId owner,
    const std::string& app_id,
    SharedImageInterfaceGetter get_shared_image_interface,
    SharedImageInterfaceGetter get_software_shared_image_interface)
    : host_frame_sink_manager_(host_frame_sink_manager),
      frame_sink_id_(frame_sink_id),
      app_id_(app_id),
      observer_(std::move(observer)),
      owner_(owner),
      get_shared_image_interface_(std::move(get_shared_image_interface)),
      get_software_shared_image_interface_(
          std::move(get_software_shared_image_interface)) {
  host_frame_sink_manager_->RegisterFrameSinkId(
      frame_sink_id_, this, viz::ReportFirstSurfaceActivation::kNo);
  // Names the app in viz traces.
  host_frame_sink_manager_->SetFrameSinkDebugLabel(
      frame_sink_id_, app_id_.empty() ? "BrokeredFrameSink" : app_id_);
}

BrokeredFrameSink::~BrokeredFrameSink() {
  if (parent_frame_sink_id_.is_valid()) {
    host_frame_sink_manager_->UnregisterFrameSinkHierarchy(
        parent_frame_sink_id_, frame_sink_id_);
  }
  host_frame_sink_manager_->InvalidateFrameSinkId(frame_sink_id_, this, {});
}

void BrokeredFrameSink::CreateCompositorFrameSink(
    mojo::PendingRemote<viz::mojom::CompositorFrameSinkClient> client,
    mojo::PendingReceiver<viz::mojom::CompositorFrameSink> receiver) {
  // The producer submits its own frames; the browser is not in the path.
  if (client && receiver) {
    host_frame_sink_manager_->CreateCompositorFrameSink(
        frame_sink_id_, std::move(receiver), std::move(client));
    return;
  }

  // Otherwise the browser builds the frames, so it is the client.
  host_frame_sink_manager_->CreateCompositorFrameSink(
      frame_sink_id_, sink_.BindNewPipeAndPassReceiver(),
      client_receiver_.BindNewPipeAndPassRemote());
}

void BrokeredFrameSink::Embed(const viz::FrameSinkId& parent_frame_sink_id,
                              const viz::LocalSurfaceId& local_surface_id,
                              const gfx::Size& size,
                              double scale,
                              double zoom) {
  // Drop a late, older id. Several <app> elements for one window share an
  // allocator but use separate pipes, so ids can arrive out of order. Viz
  // closes a sink that submits to an older id, freezing the window.
  if (local_surface_id_.is_valid() &&
      local_surface_id_.IsNewerThan(local_surface_id)) {
    return;
  }

  // A navigation or reload re-embeds under a new parent, so drop the old edge.
  if (parent_frame_sink_id_.is_valid()) {
    host_frame_sink_manager_->UnregisterFrameSinkHierarchy(
        parent_frame_sink_id_, frame_sink_id_);
  }
  parent_frame_sink_id_ = parent_frame_sink_id;
  host_frame_sink_manager_->RegisterFrameSinkHierarchy(parent_frame_sink_id_,
                                                       frame_sink_id_);

  local_surface_id_ = local_surface_id;
  size_ = size;
  scale_ = scale > 0 ? static_cast<float>(scale) : 1.f;

  if (observer_) {
    observer_->OnSurfaceEmbedded(local_surface_id, size, scale, zoom);
  }
}

uint64_t BrokeredFrameSink::ImportBuffer(
    gfx::GpuMemoryBufferHandle handle,
    const gfx::Size& size,
    uint32_t fourcc,
    const gfx::ColorSpace& color_space,
    std::optional<gpu::ExportedSharedImage>* exported) {
  const std::optional<ImportFormat> format = FormatFromFourcc(fourcc);
  if (!format) {
    LOG(ERROR) << "domicile: no SharedImageFormat for DRM fourcc 0x" << std::hex
               << fourcc
               << ". The window would be drawn with its channels permuted, so "
                  "it is refused instead.";
    return 0;
  }

  scoped_refptr<gpu::ClientSharedImage> shared_image;
  gpu::SharedImageInterface* sii = nullptr;
  const bool handle_was_dmabuf = handle.type != gfx::SHARED_MEMORY_BUFFER;
  if (!handle_was_dmabuf) {
    sii = get_software_shared_image_interface_.Run();
    if (!sii) {
      LOG(ERROR) << "domicile: a window in shared memory, but the browser "
                    "composites on the GPU, where viz draws no software "
                    "image. The producer imports a dmabuf here.";
      return 0;
    }
    // Viz reads the producer's memory itself: no copy on either side.
    const uint32_t stride = handle.stride;
    shared_image = sii->DomicileCreateSharedImageForSoftwareCompositor(
        {format->format, size, color_space,
         kTopLeft_GrSurfaceOrigin, format->alpha,
         gpu::SHARED_IMAGE_USAGE_CPU_WRITE_ONLY, "DomicileWindow"},
        std::move(handle).region(), stride);
    if (!shared_image) {
      return 0;
    }
  } else {
    sii = get_shared_image_interface_.Run();
    if (!sii) {
      LOG(ERROR) << "domicile: no GPU to import a buffer into. The ozone "
                    "platform must be one that implements "
                    "CreateNativePixmapFromHandle — headless does not.";
      return 0;
    }
    // The part of exo::Buffer this needs. Its caching, fences, protected
    // content and YUV handling are viz's job or not yet supported.
    shared_image = sii->CreateSharedImage(
        {format->format, size, color_space,
         kTopLeft_GrSurfaceOrigin, format->alpha, kWindowUsage,
         "DomicileWindow"},
        std::move(handle));
    if (!shared_image) {
      LOG(ERROR) << "domicile: the GPU refused the dmabuf";
      return 0;
    }
  }

  ImportedBuffer buffer;
  buffer.size = size;
  buffer.on_gpu = handle_was_dmabuf;
  buffer.resource = viz::TransferableResource::Make(
      shared_image, viz::TransferableResource::ResourceSource::kUI,
      sii->GenVerifiedSyncToken());
  buffer.resource.id = next_resource_id_;
  next_resource_id_ = viz::ResourceId(next_resource_id_.GetUnsafeValue() + 1);

  // Exported unconditionally; it costs only a mailbox and a sync token. See
  // ENGINE-FORK.md#buffer-import.
  *exported = shared_image->Export();
  buffer.shared_image = std::move(shared_image);

  const uint64_t buffer_id = next_buffer_id_++;
  resource_to_buffer_[buffer.resource.id] = buffer_id;
  buffers_[buffer_id] = std::move(buffer);
  return buffer_id;
}

std::optional<gpu::SyncToken> BrokeredFrameSink::GpuCreationToken(
    uint64_t buffer_id) const {
  auto iter = buffers_.find(buffer_id);
  if (iter == buffers_.end() || !iter->second.on_gpu) {
    return std::nullopt;
  }
  return iter->second.shared_image->creation_sync_token();
}

bool BrokeredFrameSink::SubmitBuffer(uint64_t buffer_id,
                                     const gfx::Rect& damage) {
  auto iter = buffers_.find(buffer_id);
  if (iter == buffers_.end() || !sink_ || !local_surface_id_.is_valid()) {
    LOG(ERROR) << "domicile: nothing to submit — buffer "
               << (iter == buffers_.end() ? "unknown" : "known") << ", sink "
               << (sink_ ? "bound" : "unbound") << ", surface "
               << (local_surface_id_.is_valid() ? "embedded" : "not embedded");
    return false;
  }
  const ImportedBuffer& buffer = iter->second;
  const gfx::Rect rect(size_);

  auto pass = viz::CompositorRenderPass::Create();
  pass->SetNew(viz::CompositorRenderPassId{1}, rect,
               damage.IsEmpty() ? rect : damage, gfx::Transform());

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

  // The client's buffer as a texture, which viz can promote to an overlay
  // instead of copying.
  viz::TextureDrawQuad* quad =
      pass->CreateAndAppendDrawQuad<viz::TextureDrawQuad>();
  quad->SetNew(quad_state, rect, rect,
               /*needs_blending=*/false, buffer.resource.id,
               /*top_left=*/gfx::PointF(0.f, 0.f),
               /*bottom_right=*/gfx::PointF(1.f, 1.f),
               /*background_color=*/SkColors::kTransparent,
               /*nearest_neighbor=*/false,
               /*secure_output_only=*/false, gfx::ProtectedVideoType::kClear,
               /*is_tex_coords_normalized=*/true);

  viz::CompositorFrame frame;
  frame.metadata.begin_frame_ack =
      viz::BeginFrameAck::CreateManualAckWithDamage();
  // `size_` is in device pixels at the page's scale.
  frame.metadata.device_scale_factor = scale_;
  frame.metadata.frame_token = ++next_frame_token_;
  // A window the page does not draw (on another workspace, behind a tab)
  // still submits a frame now and then, and each goes undrawn. Past a few
  // undrawn frames viz throttles the BeginFrames that would carry their
  // failed presentation timing, so the timing never leaves and the sink
  // observes the BeginFrameSource for good: the display ticks at its refresh
  // rate, keeping vblank interrupts on and panel self-refresh off, for a
  // window nobody sees. This sink never asks for BeginFrames to draw, so
  // there is nothing to throttle; let the timing go.
  frame.metadata.may_throttle_if_undrawn_frames = false;
  frame.resource_list.push_back(buffer.resource);
  frame.render_pass_list.push_back(std::move(pass));

  sink_->SubmitCompositorFrame(local_surface_id_, std::move(frame),
                               /*hit_test_region_list=*/std::nullopt,
                               /*submit_time=*/0);
  return true;
}

std::optional<gpu::SyncToken> BrokeredFrameSink::FenceBuffer(
    uint64_t buffer_id,
    gfx::GpuFenceHandle fence) {
  auto iter = buffers_.find(buffer_id);
  gpu::SharedImageInterface* sii = get_shared_image_interface_.Run();
  if (iter == buffers_.end() || !sii) {
    LOG(ERROR) << "domicile: cannot fence buffer " << buffer_id << " — it is "
               << (iter == buffers_.end() ? "unknown" : "known")
               << ", and there is " << (sii ? "a" : "no") << " GPU";
    return std::nullopt;
  }
  // The GPU process waits for the fence before any later read of the image,
  // as exo::Buffer does for an explicitly synchronized client.
  sii->UpdateSharedImage(gpu::SyncToken(),
                         std::make_unique<gfx::GpuFence>(std::move(fence)),
                         iter->second.shared_image->mailbox());
  // Verified because the producer has no GPU channel to verify it with, and a
  // frame carrying an unverified token is refused.
  return sii->GenVerifiedSyncToken();
}

void BrokeredFrameSink::DestroyBuffer(uint64_t buffer_id,
                                      const gpu::SyncToken& read_done) {
  auto iter = buffers_.find(buffer_id);
  if (iter == buffers_.end()) {
    return;
  }
  // The GPU destroys the image once viz's read of it lands, as
  // exo::Buffer::Texture does for a released buffer.
  iter->second.shared_image->UpdateDestructionSyncToken(read_done);
  resource_to_buffer_.erase(iter->second.resource.id);
  buffers_.erase(iter);
}

void BrokeredFrameSink::ReleaseReturnedResources(
    const std::vector<viz::ReturnedResource>& resources) {
  if (!observer_) {
    return;
  }
  for (const viz::ReturnedResource& resource : resources) {
    auto iter = resource_to_buffer_.find(resource.id);
    if (iter == resource_to_buffer_.end()) {
      continue;
    }
    // wl_buffer.release: the producer may now reuse the dmabuf.
    observer_->OnBufferReleased(iter->second);
  }
}

void BrokeredFrameSink::DidReceiveCompositorFrameAck(
    std::vector<viz::ReturnedResource> resources) {
  ReleaseReturnedResources(resources);
}

void BrokeredFrameSink::OnBeginFrame(
    const viz::BeginFrameArgs& args,
    const viz::FrameTimingDetailsMap& timing_details,
    std::vector<viz::ReturnedResource> resources) {
  ReleaseReturnedResources(resources);
  // Frames follow the client's commits, so this sink never asks for
  // BeginFrames. Viz still sends one to deliver a frame's presentation timing.
  // Viz then expects damage from this surface (SurfaceDamageExpected), so an
  // unanswered one makes the display wait for this window until the deadline.
  sink_->DidNotProduceFrame(viz::BeginFrameAck(args, /*has_damage=*/false));
}

void BrokeredFrameSink::ReclaimResources(
    std::vector<viz::ReturnedResource> resources) {
  ReleaseReturnedResources(resources);
}

void BrokeredFrameSink::OnBeginFramePausedChanged(bool paused) {}

void BrokeredFrameSink::OnCompositorFrameTransitionDirectiveProcessed(
    uint32_t sequence_id) {}

void BrokeredFrameSink::OnSurfaceEvicted(
    const viz::LocalSurfaceId& local_surface_id) {}

// Unused: the embedder allocates the LocalSurfaceIds, and registration passes
// ReportFirstSurfaceActivation::kNo.
void BrokeredFrameSink::OnFirstSurfaceActivation(
    const viz::SurfaceInfo& surface_info) {}

void BrokeredFrameSink::OnFrameTokenChanged(uint32_t frame_token,
                                            base::TimeTicks activation_time) {}

}  // namespace domicile
