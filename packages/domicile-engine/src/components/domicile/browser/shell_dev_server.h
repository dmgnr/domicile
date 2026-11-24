// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHELL_DEV_SERVER_H_
#define COMPONENTS_DOMICILE_BROWSER_SHELL_DEV_SERVER_H_

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "base/types/expected.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"

namespace domicile {

// The shell's files from a dev server, for `domicile dev`: the builder runs
// Vite on a unix socket, and the engine serves what it answers under
// `domicile://shell/`, so the shell gets hot module replacement with no TCP
// port open. See docs/architecture/DOMICILE-SCHEME.md#dev-server.
//
// Each request is one HTTP/1.0 exchange on a connection of its own, so a
// body runs until the server closes it. Vite's updates come that way: the
// page cannot open a WebSocket to its own origin, so the builder streams them
// as the body of one long request (packages/domicile-builder/src/serve.ts).

// What the engine writes to the dev server for `request`, whose body is
// `body`: the method, path and query, the headers Vite reads, and the body.
// Exposed for testing.
std::string DevServerRequest(const network::ResourceRequest& request,
                             std::string_view body);

// A response head the dev server sent.
struct DevServerHead {
  network::mojom::URLResponseHeadPtr head;
  // How much of what was read the head took. The body starts there.
  size_t length = 0;
};

// The response head at the start of `received`, nullopt until all of it has
// arrived, or why it is not one. Exposed for testing.
base::expected<std::optional<DevServerHead>, std::string> ParseDevServerHead(
    std::string_view received);

// Loads `request` from the dev server listening on `socket`. Runs on the
// calling sequence, which must be able to watch a socket: the IO thread.
void LoadFromDevServer(
    const base::FilePath& socket,
    const network::ResourceRequest& request,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHELL_DEV_SERVER_H_
