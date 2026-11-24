// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_LOADER_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_LOADER_H_

#include <string>

#include "content/public/browser/content_browser_client.h"
#include "content/public/browser/frame_tree_node_id.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"
#include "url/gurl.h"

namespace content {
class RenderFrameHost;
class WebContents;
}  // namespace content

namespace network {
class URLLoaderFactoryBuilder;
}  // namespace network

namespace domicile {

// An Electron app window's page loads the schemes its session handles from
// the app (protocol.handle), as components/domicile/browser/electron_app.h
// describes. ChromeContentBrowserClient calls these; each does nothing for
// any other page. See "Requests" in docs/architecture/ELECTRON-APPS.md.

// The loader for a navigation to `scheme` in frame `frame`, when its page's
// session handles that scheme and the network does not carry it. Otherwise
// an unbound remote.
mojo::PendingRemote<network::mojom::URLLoaderFactory>
ElectronNavigationLoaderFactory(const std::string& scheme,
                                content::FrameTreeNodeId frame);

// Adds loaders for the schemes, besides http and https, that the session of
// frame `render_frame_id`'s page handles. Its file: loader replaces
// content's, which reads any file: the app decides what file: serves, as
// in Electron.
void AddElectronSubresourceLoaderFactories(
    int render_process_id,
    int render_frame_id,
    content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap* factories);

// Puts the app in front of `frame`'s network loads: an http or https
// request its session handles goes to the app, and any other to the
// network as before.
void ProxyElectronNetworkLoads(content::RenderFrameHost* frame,
                               network::URLLoaderFactoryBuilder& builder);

// Whether `guest`, an Electron app window's page, may load `url`, whose
// scheme content keeps out of guests: its session handles the scheme.
bool MayElectronPageLoad(content::WebContents* guest, const GURL& url);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_LOADER_H_
