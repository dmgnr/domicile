// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/external_surface_provider.h"

#include <cmath>
#include <utility>

#include "base/functional/bind.h"
#include "components/domicile/browser/frame_sink_broker.h"

namespace domicile {

ExternalSurfaceProvider::ExternalSurfaceProvider(FrameSinkBroker* broker)
    : broker_(broker) {
  CHECK(broker);
  // Unretained: `receivers_` is a member, so the handler cannot outlive this.
  receivers_.set_disconnect_handler(base::BindRepeating(
      &ExternalSurfaceProvider::OnPageDisconnected, base::Unretained(this)));
}

ExternalSurfaceProvider::~ExternalSurfaceProvider() = default;

void ExternalSurfaceProvider::Bind(
    mojo::PendingReceiver<mojom::ExternalSurfaceProvider> receiver,
    uint32_t renderer_client_id) {
  receivers_.Add(this, std::move(receiver),
                 Page{renderer_client_id, broker_->NewEmbedRequester()});
}

// The page only grants access here: it names its parent frame sink and
// allocates the LocalSurfaceId. The parent must be in the calling renderer's
// namespace, as content::EmbeddedFrameSinkProviderImpl requires.
void ExternalSurfaceProvider::Embed(
    const std::string& app_id,
    const viz::FrameSinkId& parent_frame_sink_id,
    const viz::LocalSurfaceId& local_surface_id,
    const gfx::Size& size,
    double scale,
    double zoom,
    EmbedCallback callback) {
  const Page& page = receivers_.current_context();
  if (parent_frame_sink_id.client_id() != page.renderer_client_id) {
    receivers_.ReportBadMessage("parent frame sink is not the renderer's");
  } else if (!std::isfinite(zoom) || zoom <= 0) {
    // The compositor divides the box by it.
    receivers_.ReportBadMessage("zoom is not a positive number");
  } else {
    broker_->Embed(page.requester, app_id, parent_frame_sink_id,
                   local_surface_id, size, scale, zoom, std::move(callback));
  }
}

void ExternalSurfaceProvider::WaitForEnd(const viz::FrameSinkId& frame_sink_id,
                                         WaitForEndCallback callback) {
  broker_->WaitForEnd(frame_sink_id, std::move(callback));
}

// The element was collected or its renderer went away. Its pending replies
// have nowhere to go.
void ExternalSurfaceProvider::OnPageDisconnected() {
  broker_->DropEmbeds(receivers_.current_context().requester);
}

}  // namespace domicile
