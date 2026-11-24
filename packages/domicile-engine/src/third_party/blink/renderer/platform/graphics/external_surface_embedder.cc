// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/platform/graphics/external_surface_embedder.h"

#include <map>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "components/viz/common/surfaces/parent_local_surface_id_allocator.h"
#include "third_party/blink/public/platform/browser_interface_broker_proxy.h"

namespace blink {
namespace {

// One allocator per app id, shared by every element that names that app.
//
// Per app because viz keys SurfaceAllocationGroup on the embed_token alone and
// refuses one token across frame sinks ("Cannot reuse embed token across frame
// sinks"). A shared allocator would leave every window after the first without
// a surface. Per app also keeps a kReconfigure for one window from changing the
// surface ids of the others.
//
// A restarted compositor reuses app ids, and the browser brokers them new
// FrameSinkIds, which hit the same refusal. So the loss of an app's frame sink
// invalidates its allocator with a new embed token (OnEnded).
//
// `std::map` rather than `base::flat_map`: callers hold references into the
// map, and a flat_map insert would invalidate them.
struct AppSurface {
  viz::ParentLocalSurfaceIdAllocator allocator;
  // What the current LocalSurfaceId was allocated for. The producer renders at
  // the size it was embedded with, and viz rejects a frame of a different size
  // for a surface that already has one.
  gfx::Size size;
  double scale = 0;
  double zoom = 0;
};

AppSurface& SurfaceForApp(const String& app_id) {
  static base::NoDestructor<std::map<std::string, AppSurface>> surfaces;
  return (*surfaces)[app_id.Utf8()];
}

}  // namespace

ExternalSurfaceEmbedder::ExternalSurfaceEmbedder(
    const BrowserInterfaceBrokerProxy& broker,
    base::RepeatingClosure lost)
    : lost_(std::move(lost)) {
  broker.GetInterface(provider_.BindNewPipeAndPassReceiver());
}

ExternalSurfaceEmbedder::~ExternalSurfaceEmbedder() = default;

viz::LocalSurfaceId ExternalSurfaceEmbedder::Embed(
    const String& app_id,
    const viz::FrameSinkId& parent_frame_sink_id,
    const gfx::Size& size,
    double scale,
    double zoom,
    Allocation allocation,
    EmbeddedCallback callback) {
  // Allocate before the round trip: the browser passes this half of the
  // SurfaceId to the producer, which cannot create one.
  //
  // An adopt at a different size, scale or zoom gets a new id too. A reloaded
  // shell is a new document in the same renderer, so its first embed is an
  // adopt of the old document's surface, usually at a new box size. Reusing the
  // id at that size makes viz close the producer's frame sink.
  AppSurface& surface = SurfaceForApp(app_id);
  viz::ParentLocalSurfaceIdAllocator& allocator = surface.allocator;
  if (allocation == Allocation::kReconfigure ||
      !allocator.HasValidLocalSurfaceId() || surface.size != size ||
      surface.scale != scale || surface.zoom != zoom) {
    allocator.GenerateId();
    surface.size = size;
    surface.scale = scale;
    surface.zoom = zoom;
  }
  const viz::LocalSurfaceId local_surface_id =
      allocator.GetCurrentLocalSurfaceId();

  // Temporary spike logging: pairs the requested app with the allocated
  // surface, the two facts needed to debug a page showing the wrong window.
  LOG(INFO) << "domicile: embedding \"" << app_id.Utf8() << "\" at "
            << local_surface_id.ToString() << " under "
            << parent_frame_sink_id.ToString() << ", " << size.ToString();

  provider_->Embed(app_id, parent_frame_sink_id, local_surface_id, size, scale,
                   zoom,
                   base::BindOnce(&ExternalSurfaceEmbedder::OnEmbedded,
                                  base::Unretained(this), std::move(callback),
                                  app_id, local_surface_id));
  return local_surface_id;
}

void ExternalSurfaceEmbedder::OnEmbedded(
    EmbeddedCallback callback,
    const String& app_id,
    const viz::LocalSurfaceId& local_surface_id,
    const std::optional<viz::FrameSinkId>& frame_sink_id) {
  if (!frame_sink_id) {
    LOG(INFO) << "domicile: no surface for \"" << app_id.Utf8() << "\"";
    std::move(callback).Run(std::nullopt);
    return;
  }
  const viz::SurfaceId surface_id(*frame_sink_id, local_surface_id);
  LOG(INFO) << "domicile: embedded \"" << app_id.Utf8() << "\" as "
            << surface_id.ToString();
  // One wait per frame sink: every resize embeds again under the same one.
  if (*frame_sink_id != watched_frame_sink_id_) {
    watched_frame_sink_id_ = *frame_sink_id;
    provider_->WaitForEnd(
        *frame_sink_id,
        base::BindOnce(&ExternalSurfaceEmbedder::OnEnded,
                       base::Unretained(this), app_id, surface_id));
  }
  std::move(callback).Run(surface_id);
}

void ExternalSurfaceEmbedder::OnEnded(
    const String& app_id,
    const viz::SurfaceId& surface_id,
    domicile::mojom::blink::FrameSinkEnd end) {
  // An end of a frame sink this embedder has since moved off changes nothing
  // it shows.
  const bool shown = surface_id.frame_sink_id() == watched_frame_sink_id_;
  if (shown) {
    watched_frame_sink_id_ = viz::FrameSinkId();
  }
  // A closed window's app id never returns, so there is nothing to embed again.
  if (end != domicile::mojom::blink::FrameSinkEnd::kProducerGone) {
    return;
  }
  LOG(INFO) << "domicile: lost \"" << app_id.Utf8() << "\" at "
            << surface_id.ToString();
  // Several embedders of one app share its allocator. Only the first to hear
  // of the loss replaces the token, so they all embed the same new surface.
  viz::ParentLocalSurfaceIdAllocator& allocator =
      SurfaceForApp(app_id).allocator;
  if (allocator.GetEmbedToken() ==
      surface_id.local_surface_id().embed_token()) {
    allocator.Invalidate(/*also_invalidate_allocation_group=*/true);
  }
  if (shown && lost_) {
    lost_.Run();
  }
}

}  // namespace blink
