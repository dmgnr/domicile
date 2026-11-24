// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_WEB_REQUEST_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_WEB_REQUEST_H_

#include <cstdint>
#include <optional>
#include <string>

#include "base/memory/weak_ptr.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/mojom/url_loader.mojom-forward.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"

namespace network {
struct ResourceRequest;
}  // namespace network

namespace domicile {

class ElectronSession;

// Starts `request`, an Electron app window's page's network load, through
// its session's webRequest listeners (session.webRequest), as Electron
// does: onBeforeRequest may cancel or redirect it, onBeforeSendHeaders may
// replace its headers, onHeadersReceived may cancel it or replace the
// response's headers, and the rest hear how it went. It loads through
// `network`, a clone of the page's network loader. `window` is the desk
// window whose page made it, when one did. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.
//
// The listeners see the headers the page sent, not those the network
// service adds later (cookies among them).
void StartElectronWebRequest(
    base::WeakPtr<ElectronSession> session,
    std::optional<std::string> window,
    mojo::PendingRemote<network::mojom::URLLoaderFactory> network,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_WEB_REQUEST_H_
