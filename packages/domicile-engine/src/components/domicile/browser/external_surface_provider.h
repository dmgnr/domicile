// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_EXTERNAL_SURFACE_PROVIDER_H_
#define COMPONENTS_DOMICILE_BROWSER_EXTERNAL_SURFACE_PROVIDER_H_

#include <cstdint>
#include <string>

#include "base/memory/raw_ptr.h"
#include "components/domicile/mojom/external_surface.mojom.h"
#include "components/viz/common/surfaces/frame_sink_id.h"
#include "components/viz/common/surfaces/local_surface_id.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "ui/gfx/geometry/size.h"

namespace domicile {

class FrameSinkBroker;

// The broker methods a renderer may call.
//
// A FrameSinkBroker pipe can allocate any frame sink in the browser's
// namespace, so pages must not hold one. A page may only announce a
// LocalSurfaceId and size it allocated, whose embed_token is what the producer
// needs, and hear why a surface ended.
class ExternalSurfaceProvider : public mojom::ExternalSurfaceProvider {
 public:
  explicit ExternalSurfaceProvider(FrameSinkBroker* broker);

  ExternalSurfaceProvider(const ExternalSurfaceProvider&) = delete;
  ExternalSurfaceProvider& operator=(const ExternalSurfaceProvider&) = delete;

  ~ExternalSurfaceProvider() override;

  // Binds a page in the renderer whose frame sinks have client id
  // `renderer_client_id`.
  void Bind(mojo::PendingReceiver<mojom::ExternalSurfaceProvider> receiver,
            uint32_t renderer_client_id);

  // mojom::ExternalSurfaceProvider implementation.
  void Embed(const std::string& app_id,
             const viz::FrameSinkId& parent_frame_sink_id,
             const viz::LocalSurfaceId& local_surface_id,
             const gfx::Size& size,
             double scale,
             double zoom,
             EmbedCallback callback) override;
  void WaitForEnd(const viz::FrameSinkId& frame_sink_id,
                  WaitForEndCallback callback) override;

 private:
  // One bound page.
  struct Page {
    // Its renderer's frame sink client id.
    uint32_t renderer_client_id;
    // Its id from FrameSinkBroker::NewEmbedRequester.
    uint64_t requester;
  };

  // Drops the disconnected page's waiting embeds.
  void OnPageDisconnected();

  const raw_ptr<FrameSinkBroker> broker_;

  mojo::ReceiverSet<mojom::ExternalSurfaceProvider, Page> receivers_;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_EXTERNAL_SURFACE_PROVIDER_H_
