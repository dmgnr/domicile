# `domicile://`: serving the shell without a port

The engine serves the shell page from a custom scheme, `domicile://`, and the
page reaches the compositor through the desktop handed to its `Shell`. No TCP
port is open.
Patches `0008`, `0009` and `0126`.

## Why

- The shell's JavaScript needs a real origin. `file:` has none (no WebSocket,
  restricted `fetch`), and JavaScript cannot open a unix socket.
- The compositor's control channel is the desktop's control plane. It accepts
  `Spawn { command }` (run any command) and synthetic `Key` and
  `PointerButton` events into any window. It reports every window title and
  every keystroke (`AppTitled`, `Displays`, `Modifiers`).
- A loopback port exposes that to every process on the machine. An `Origin`
  check stops other browser pages but not `curl`, which forges any header. With
  no port, the only way in is the compositor's socket under
  `XDG_RUNTIME_DIR`, which is mode 700 and owned by the user.

Do not add a loopback server for a page that needs a channel. Use this scheme
and the binding.

## `domicile://shell/`

- A standard scheme that is neither web-safe nor CORS-enabled. It has a real
  origin, and web content cannot navigate to it.
- Registered through `ContentClient::AddAdditionalSchemes`, and in each
  renderer as supporting the Fetch API, so a document `fetch()`es its own
  files (the splash reads `progress.json`).
- Every frame's subresource factory serves the scheme, so the factory checks
  who asks (`ShellURLLoaderFactory::MayReadFiles`). The shell's files go only
  to `domicile://shell` and an app's only to its own origin, whether by
  `fetch()`, `XMLHttpRequest` or `<img>`. Navigations are gated by the scheme
  not being web-safe and by `MayShowInWebView`.
- Loaded through `ContentBrowserClient::CreateNonNetworkNavigationURLLoaderFactory`
  (navigation), `RegisterNonNetworkSubresourceURLLoaderFactories`
  (subresources) and `RegisterNonNetworkWorkerMainResourceURLLoaderFactories`
  (a dedicated or shared worker's main script, which the browser fetches).
- `--domicile-shell-root` and `--domicile-shell-module` say what to serve.
- Requests must resolve inside the shell root. Directory listings are off.
- Shell files and the document are served `Cache-Control: no-store`. Blink
  otherwise reuses non-HTTP responses across documents, and a rebuilt shell
  keeps its file names.
- The document is served with
  `Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'`. Only files
  under the shell root run, so markup the shell renders from outside cannot
  run script with the desktop. Those files may compile WebAssembly. See
  [SHELL-PACKAGING.md](/docs/SHELL-PACKAGING.md#scripts).

The fork writes the shell's HTML document
(`components/domicile/browser/shell_url_loader_factory.cc`). It sets:

- a charset, so the page is not decoded by guesswork
- a viewport, so the engine does not lay out for a phone
- a root with no margin, so the page fills the area the compositor assigned it
- a `domicile-shell-module` meta naming the shell module. The document runs no
  script: Blink's `DomicileShell` imports the module once the document is
  parsed and calls `Shell(document.body, domicile)`
- `@view-transition { navigation: auto }`. `load_shell` navigates the shell
  window (a renderer-initiated replacement, not a reload), so the shell before,
  such as the splash, crossfades into the new one over 600 ms
- no frame until `Shell` returns. Blink's `DomicileShell` holds the document's
  rendering until then, so the crossfade is into the shell, not an empty white
  page

## Dev server

`domicile dev <entry>` serves a shell from its source with Vite, for hot
module replacement
([WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md#hot-module-replacement)). The
page stays on `domicile://shell/`, so it keeps its origin, its CSP and its
capabilities, and no TCP port opens.

- The builder runs Vite's dev server on a unix socket in `XDG_RUNTIME_DIR`,
  mode 600 (`packages/domicile-builder/src/serve.ts`).
- `load_shell` with `"dev_server": true`, or `--domicile-shell-dev-server` at
  launch, makes the shell root that socket. The supervisor passes the switch
  again when it restarts the engine.
- The engine still writes the document. It imports `domicile-dev-shell.js`,
  which runs what Vite's plugins add to a page (its client, React's Fast
  Refresh preamble), then exports the entry's `Shell`.
- Every other request under `domicile://shell/` goes to the socket as one
  HTTP/1.0 request on its own connection, with its path, query, method and
  body. The response streams back as it arrives, with `Cache-Control:
  no-store` (`components/domicile/browser/shell_dev_server.{h,cc}`).
- A WebSocket to the page's own origin is not possible, so Vite's client gets
  its updates from one long `GET /@domicile/hmr`, one JSON message per line,
  and sends its messages with `POST /@domicile/hmr?client=<id>`.
- When the dev server is gone, the page's imports fail, and the engine logs
  why.

## `domicile://home/`

The user's home directory, for launcher previews (an `<img>`, `<video>` or PDF
of a file search found). Beyond the shell root's containment it refuses:

- any path containing a dotfile (the file index uses the same rule)
- any request whose initiator is not `domicile://shell`. The subresource
  factory serves every frame, so without this a site in a `<webview>` could
  probe which files exist. The shell may `fetch()` from home.
- every request while the desk is locked

## `domicile://app-<id>/`

An app module's files ([APP-MODULES.md](APP-MODULES.md)), one host per app.

- `<id>` is the first 32 hex digits of the SHA-256 of the app's root, so each
  directory has its own origin and storage
  (`components/domicile/browser/app_roots.h`).
- Served only for an app `run_app` added. The bare root is a document the
  engine writes, naming the module in a `domicile-app-module` meta; Blink's
  `DomicileApp` calls its `main`.
- Files are served `Cache-Control: no-store`, as the shell's are. No
  Content-Security-Policy: an app sets its own.
- Cross-origin isolated, as the shell is. See
  [Cross-origin isolation](#cross-origin-isolation).
- Shown only in the window `run_app` opened for it
  (`WebViewGuest::PinToApp`). `MayShowInWebView` and the guest's navigation
  throttle refuse it in any other `<webview>`.
- The shell's interfaces bind only for `domicile://shell`'s origin. An app
  binds `AppChannel` instead: system calls only.

## Cross-origin isolation

`domicile://shell` and every `domicile://app-<id>` are cross-origin isolated,
always, with no headers.

- `crossOriginIsolated` is true and `SharedArrayBuffer` exists, in the page and
  its workers. Threaded wasm and tools that check `crossOriginIsolated`, such
  as the TypeScript service, work.
- Nothing is enforced: no COOP, COEP or Document-Isolation-Policy. What the
  page loads is not checked for CORP, so images, fetches and iframes from other
  origins load as before.
- These pages run with the desktop's trust, as a native program does, so they
  are trusted with shared memory. `<webview>` pages and `domicile://home` are
  not isolated.
- `ContentBrowserClient::IsCrossOriginIsolatedByEmbedder` names the origins
  (`IsCrossOriginIsolatedOrigin`). `NavigationRequest` then isolates the
  document as Document-Isolation-Policy does: its own process and a concrete
  isolation key (patch 0225).

## The control channel

- `--domicile-control-socket` names the compositor's socket. The engine holds
  it, not the page.
- `components/domicile/mojom/control_channel.mojom` defines the protocol.
- [CONTROL-CHANNEL.md](/packages/domicile-engine/docs/CONTROL-CHANNEL.md) has
  the details.
