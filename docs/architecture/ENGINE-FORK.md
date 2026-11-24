# Engine fork: `<app>` is a `SurfaceLayer`

Domicile forks Chromium so that `<app>` is backed by a `cc::SurfaceLayer`. The
layer embeds a viz surface that `domicile-compositor` submits from a Wayland
client's dmabuf.

- Out-of-process `<iframe>`s and hardware-decoded `<video>` use the same
  mechanism.
- CSS works on an `<app>` the way it works on any element: the page's own
  compositor applies z-index, transform, clip, opacity, filters and blend modes
  to the layer.
- The client's buffer reaches the screen as a texture quad, which viz can
  promote to a hardware overlay.
- The fork is mostly new files, so it is cheap to carry across Chromium
  releases.

Related docs:

- [ENGINE-FORK-MEASUREMENTS.md](ENGINE-FORK-MEASUREMENTS.md): the CSS parity,
  latency and dmabuf measurements behind this design.
- [ENGINE-FORK-CHROMIUM-NOTES.md](ENGINE-FORK-CHROMIUM-NOTES.md): Chromium
  behavior found while building it (mojo transport, Rust bindings, Ozone
  platforms and dmabuf import).
- [DOMICILE-SCHEME.md](DOMICILE-SCHEME.md): how the shell page is served and
  reaches the compositor.
- [`packages/domicile-engine/docs/BUILDING-CHROMIUM.md`](/packages/domicile-engine/docs/BUILDING-CHROMIUM.md):
  checking out and building the engine.

## Problem

Chromium does not expose its layer tree. The page reaches the compositor as one
flat raster, so the only way to put a window between page elements is to split
the page into bands. Bands force `data-band` onto every painting element, which
breaks CSS parity and makes shells complicated.
[STACKING-PARITY.md](STACKING-PARITY.md) has the evidence.

## Design

```
  wayland client ──dmabuf──▶ domicile ──CompositorFrame──▶ viz ──┐
                             (viz client)                        │ aggregates
                                                                 ▼
  page: <app> ──SurfaceLayer(SurfaceId)──▶ cc layer tree ──▶ viz ─┴─▶ display
```

The page and the compositor share only a `viz::SurfaceId`. The page never sees
the window's pixels. The compositor never sees the page's layout.

### The embedder allocates, the producer submits

Chromium embeds out-of-process iframes the same way (`RemoteFrame`,
`third_party/blink/renderer/core/frame/remote_frame.cc`).

- A `SurfaceId` is a `FrameSinkId` plus a `LocalSurfaceId`.
- The page allocates the `LocalSurfaceId`. When the `<app>` box resizes, the
  page bumps `parent_sequence_number` and the client gets a configure with the
  new size.
- The `LocalSurfaceId` carries an `embed_token`, an unguessable token the
  embedder generates. Holding the token is the permission to embed. Viz refuses
  an id whose allocation group does not match its submitter.
- `cc::SurfaceLayer` is an ordinary `cc::Layer`, so it sits in the property
  trees with every other layer. That is what gives CSS parity.

The browser's jobs:

- allocate the producer a `FrameSinkId`
- register the frame-sink hierarchy so `BeginFrame`s flow
- pass ids between the page and the producer

| Id | Supplied by | Why |
|---|---|---|
| `FrameSinkId` | the browser | It is in client id 0, the browser's namespace. Renderers cannot name ids outside their own. |
| `LocalSurfaceId` | the page | The page is the embedder. Its `embed_token` is the capability the producer needs to submit. |

### Brokering a frame sink to a non-renderer

Viz does no authorization: `FrameSinkManagerImpl::CreateCompositorFrameSink`
rejects only a duplicate `FrameSinkId` or a missing bundle. The browser makes
every decision.

- Renderer ids are checked against the renderer's own namespace (its child
  process id, always 1 or more).
- The browser's namespace is `kBrowserClientId = 0`. No renderer can name an id
  in it.
- `content::AllocateFrameSinkId()` and `content::GetHostFrameSinkManager()` are
  exported free functions, so a browser-process service needs no
  `RenderProcessHost`.

- `FrameSinkBroker` (`components/domicile/browser/`) allocates the
  `FrameSinkId` itself, in the browser namespace.
- It uses the browser's injected allocator. A second `FrameSinkIdAllocator(0)`
  would reuse ids.
- Only the named socket below reaches it, because it can allocate any frame
  sink.

### How the producer reaches the broker

- The browser listens on a named socket (`mojo::NamedPlatformChannel`) and
  sends a real mojo invitation. The producer joins the browser's mojo graph.
- The socket path is the access control. Only the user can open it.
- The socket opens at browser startup (patch `0004`, one line in
  `browser_main_loop.cc`). It cannot wait for a page: the page mounts `<app>`
  only after the compositor announces a window, and the compositor is the
  producer that connects over this socket.
- `mojo::IsolatedConnection` does not work here. A process on it cannot forward
  a received handle, and the broker forwards the producer's
  `CompositorFrameSink` receiver to the viz process.

[ENGINE-FORK-CHROMIUM-NOTES.md](ENGINE-FORK-CHROMIUM-NOTES.md#mojo-invitations)
lists two undocumented transport constraints.

### Embedding in the page

`<app app-id="…">` is a real element, `HTMLAppElement` (patch `0007`).

- It exists only in the shell's document, `domicile://shell/` (patch `0116`).
  `DomicileExternalSurface` is an origin trial feature that `DomicileShell`
  turns on there. Elsewhere `<app>` is an `HTMLUnknownElement`. A page that
  embedded a window would take its pixels from the shell, since the last embed
  wins.

- `LayoutAppSurface::UpdateAfterLayout` reports the box layout gave it.
- `ExternalSurfaceEmbedder` resolves the `SurfaceId` for the app id.
- `SurfaceLayerBridge::EmbedSurface` and `cc::SurfaceLayer::SetSurfaceId` do not
  check which namespace the surface belongs to, so the page embeds a surface it
  did not allocate without changes to either.
- `canvas.embedExternalSurface()` (patch `0002`) does the same embed, also only
  in the shell. `spike-page.html`, `spike-iframe-page.html` and
  `guard-two-windows.html` use it.
- A fork element must override `Node::GetElementType`. Without it, casts to
  the element return null and `<app>` never embeds.
  `packages/domicile-engine/tests/test-fork-elements-know-their-type.sh` checks this.

Two mojo interfaces carry the ids:

| Interface | Direction | Carries |
|---|---|---|
| `domicile.mojom.ExternalSurfaceProvider` | renderer → browser | `Embed`: the page's `LocalSurfaceId` and size. Returns the `FrameSinkId`. A page naming a surface it was not offered gets an empty one. Bound per frame; a frame whose origin is not `domicile://shell` is a bad message (patch `0116`). A parent frame sink outside the calling renderer is a bad message (patch `0107`). `WaitForEnd`: replies when a brokered `FrameSinkId` ends, and whether the window closed or the compositor went away. |
| `domicile.mojom.SurfaceObserver` | browser → producer | A `LocalSurfaceId` and a size, sent again whenever the box changes. |

### One engine, many surfaces

- The compositor opens one socket to the browser and creates one surface per
  window.
- Viz allows only one frame sink per embed token, so each app id gets its own
  `LocalSurfaceId` allocator in the renderer.
- Several elements naming one app show one producer. Different apps get
  different surfaces.
- `third_party/blink/renderer/platform/graphics/external_surface_embedder.h`
  has the details.

### A compositor restart

App ids come from a counter that restarts with the compositor, so the new
compositor's `app-1` gets a new `FrameSinkId`. Viz refuses one embed token on
two frame sinks, so the page needs a new token for it.

- After each embed, `ExternalSurfaceEmbedder` calls `WaitForEnd` on the
  `FrameSinkId`, once per frame sink.
- The broker replies `kClosed` when the producer destroys the sink, and
  `kProducerGone` when the producer disconnects. A wait on a sink already gone
  gets the same answer at once; the broker keeps the ids of sinks lost to a
  disconnect.
- On `kProducerGone`, the embedder invalidates the app's allocator with a new
  embed token, and `<app>` embeds again. The browser holds that embed until the
  new compositor brokers the app. On `kClosed` nothing embeds again, since a
  closed window's app id never returns.
- An embed sent before the page heard of the disconnect carries the old token.
  The broker answers it null at once instead of passing it to the new
  producer, and `<app>` retries with the new token.
- The engine listens on the broker socket again when the producer
  disconnects (`FrameSinkBroker::SetProducerGoneCallback`), since an
  invitation is accepted once.
- The page's control channel dials the new compositor
  (`control_channel.cc`). Before it does, the page hears every window of the
  old one close and every open system call end with `compositor_gone`. Then
  `DomicileHost` sends the page's size and density again and fires
  `compositorreplaced`, and the new compositor's state follows. The SDK sends each watch and D-Bus match again,
  and streams `Listened.Missed()` once the new compositor starts it.
- An app module's channel (`app_channel.cc`) ends its calls the same way and
  dials the new compositor. Both channels track calls with `OpenCalls`
  (`system_call.h`).
- Wayland clients lose their display. The new compositor launches again the
  ones Domicile launched
  ([THE-DOMICILE-BINARY.md](THE-DOMICILE-BINARY.md#crashes-are-recovered)).
- `guard-app-survives-compositor-restart.sh` covers the re-embed and the
  watch.

### Embed deadlines

A resized window holds back the shell's frame until it draws at the new size,
up to viz's default deadline. The box and the window change in one frame, as
on other Wayland compositors.

- **`<app>`:** a resize embeds the surface for the new box with the default
  deadline, in the frame whose layout changed the box (`html_app_element.cc`,
  patch `0102`). A first embed uses deadline 0.
- **Interactive resize:** while an `<app>` has the `resizing` attribute (patch
  `0113`), a resize embeds with deadline 0, so a slow client cannot hold every
  frame of a drag. The client's latest frame shows at its own size from the
  top left corner, not stretched to the box (patch `0149`): stretched, it
  would snap to the client's own frame on every arrival. Removing the
  attribute re-embeds the box once with the default deadline, if a resize
  happened meanwhile.
- **The compositor** shows each commit at the box of the configure the client
  acked (`configure_box`, `domicile_surface_submit_for_box`,
  `configure_answers.rs`). An old buffer stays at its old surface instead of
  meeting the new box stretched.
- **Pacing:** each toplevel has at most three unanswered size configures.
  Newer boxes wait; the newest goes out when the client commits after acking
  one, or after 500 ms (`PATIENCE`) for a client that never answers. A slow
  client skips the sizes it could not draw instead of queueing them.
  - Three: Chromium (and so Electron) draws up to three sizes at once and acks
    each when its frame is ready, so it needs three to draw a new size every
    frame of a drag. KWin sets no limit.
  - A client that never answers gets at most three sizes each `PATIENCE`.
- **`<webview>`:** the guest keeps upstream's default deadline, as an
  out-of-process `<iframe>` does, except while the `<webview>` has `resizing`
  (patch `0145`): then `RemoteFrame` embeds with deadline 0, and the guest's
  latest frame shows at its own size until the page draws at the new box.
- **Cost:** a client slower than the deadline slows the whole desktop during a
  resize without `resizing`. Past the deadline, viz shows the window's last frame stretched.
- `packages/domicile-engine/tests/test-a-resized-window-holds-the-shell-until-it-draws.sh` checks
  this.

## The C ABI

`libdomicile_engine.so` is the seam between the compositor and the browser.

- The library is C++ built by GN. It owns the mojo side: the invitation, the
  `FrameSinkBroker` pipe, the `SharedImage` handoff and `CompositorFrame`
  assembly.
- `domicile-compositor` (Rust) owns the Wayland side.
- The compositor `dlopen`s the library, so `cargo build` needs no Chromium
  checkout. CI has none. If the library fails to load, the compositor refuses
  to start (see [ERRORS.md](/docs/guidelines/ERRORS.md)).
- The library does not own the thread. It exposes a pollable fd, like
  `wl_display_get_fd` / `wl_display_dispatch`. Callbacks fire only inside
  `dispatch`, on the caller's thread:

```c
int  domicile_engine_fd(DomicileEngine*);       // add to calloop
void domicile_engine_dispatch(DomicileEngine*); // run pending work, fire callbacks
```

Each entry maps onto a Wayland request the compositor already handles.

Calls (compositor → engine):

| C ABI | Wayland equivalent |
|---|---|
| `domicile_surface_create(engine, app_id)` → `DomicileSurfaceId` | a window appearing. The page's embed waits for this call. |
| `domicile_surface_import_async(surface, dmabuf, request)`, answered by `imported` | `zwp_linux_dmabuf_v1`. `domicile_surface_import` is the blocking form an older compositor calls. |
| `domicile_surface_set_color(surface, color)` | `wp_color_management_surface_v1.set_image_description`: buffers imported after it are drawn in that color ([COLOR.md](COLOR.md)) |
| `domicile_surface_import_shm(surface, buffer)` | `wl_shm`, for an engine on the CPU. Blocks; refused while the browser composites on the GPU ([`wl_shm` clients on the CPU](WINDOW-COMPOSITING.md#wl_shm-clients-on-the-cpu)). |
| `domicile_surface_submit_transformed(surface, buffer, crop, damage, box, transform)` | `wl_surface.commit` with `xdg_surface.set_window_geometry` and `wl_surface.set_buffer_transform`, shown at the box of the acked configure |
| `domicile_surface_submit_fenced(…, transform, acquire_fence)` | the same, read once `acquire_fence` signals, like `zwp_linux_surface_synchronization_v1`'s acquire fence. The compositor's shm copies use it ([WINDOW-COMPOSITING.md](WINDOW-COMPOSITING.md#wl_shm-clients-on-a-gpu)). |
| `domicile_surface_sync(engine, surface, frame)` | a commit whose popup or bubble the page moves: later submits go up at synced frame `frame` ([Synced frames](WINDOW-COMPOSITING.md#synced-frames)) |
| `domicile_displays_configure(layout, count)` | output configuration |
| `domicile_displays_set_gamma(engine, display, ramp, size)` | `wlr-gamma-control`'s `set_gamma`: one monitor's ramp, for the night light or a client ([DISPLAYS.md](../DISPLAYS.md#night-light-and-gamma-control)) |
| `domicile_input_inject(engine, input)` | none: emulated input (EIS) delivered as the engine's own devices' would be, on a headless desk ([A-HEADLESS-DESKTOP.md](A-HEADLESS-DESKTOP.md)) |
| `domicile_pointers_configure(targets, count)` | input-to-output mapping, as sway's `map_to_output` ([DISPLAYS.md](../DISPLAYS.md#tablets-and-touchscreens)) |
| `domicile_clipboard_set_items(clipboard, items, count)` | `wl_data_offer.receive`. The compositor sends the selection it already read: its text and its image, each a `DomicileClipboardItem`. `domicile_clipboard_set(clipboard, text, length)` is the text-only form an older compositor calls. |
| `domicile_display_capture_start(engine, display, width, height, max_fps)`, `_resize`, `_stop` | none: a screen cast of a monitor (see [Display capture](#display-capture)) |
| `domicile_browser_window_capture_start(engine, window_id, max_fps)` | none: a screenshot of one browser window alone; resized, stopped and released as a display capture |
| `domicile_captured_frame_release(engine, capture, frame)` | none: the compositor is done reading a captured frame |
| `domicile_engine_reports_frames()` | none: says the engine calls `frame_done` and `presented`, so the compositor waits for them |

Callbacks (engine → compositor):

| C ABI | Wayland equivalent |
|---|---|
| `released(surface, buffer)` | `wl_buffer.release` |
| `imported(surface, request, buffer)` | none: the answer to `domicile_surface_import_async`; zero is a refusal |
| `configure(surface, width, height)`, `configure_at(…, scale)`, `configure_box(…, box)`, `configure_zoomed(…, zoom, box)` | `xdg_toplevel.configure` |
| `ramped_displays(displays, count)` | `wl_output`. Primary first, never empty. Each display with its connector and gamma ramp size. `connected_displays` is the form without ramp sizes and `displays` the form without connectors, each called when the ones before it are unset. |
| `copied_items(clipboard, items, count)` | `wl_data_device.set_selection` for a copy made in a page: its text and its image. `copied(clipboard, text, length)` is the text-only form, called when `copied_items` is unset. |
| `captured(capture, frame, record)`, `capture_ended(capture)` | none: a monitor's frame for a screen cast, and the browser ending the capture |
| `frame_done(surface, frame)` | `wl_surface.frame`'s `done`: viz acked the frame |
| `presented(surface, frame, time_ns, refresh_ns, flags)` | `wp_presentation_feedback`: from the frame's `FrameTimingDetails`, or discarded |
| `disconnected()` | none: the browser went away, so the next page's `hello` is a new engine ([THE-DOMICILE-BINARY.md](THE-DOMICILE-BINARY.md#crashes-are-recovered)) |
| `compositing(in_memory)` | none: the browser composites in memory, or on the GPU. Sent once known and on every change ([Software output](A-DESKTOP-ON-A-TTY.md#software-output)) |
| `browser_windows(windows, count)` | `ext_foreign_toplevel_list_v1.toplevel`: the browser's windows, each a `DomicileBrowserWindow` (id, title, app id), in open order. Sent on connect and when one opens, closes, navigates or is retitled ([Wayland capture](../PORTALS.md#wayland-capture)) |
| `listed_browser_windows(windows, count)` | Called instead of `browser_windows` when set: each window a `DomicileListedBrowserWindow`, adding its address and whether it is private. `domicile list-windows` reads it too. An older engine ignores it |
| `viewed_browser_windows(windows, count, views, view_count)` | Called instead of `listed_browser_windows` when set: adds the views each window holds and shows, each a `DomicileBrowserWindowView` (id, window index, place in the window's page), bottom first. A shot of the window draws them ([PORTALS.md](../PORTALS.md)). An older engine ignores it |
| `input_devices(devices, count)` | The keyboards, pointers and touch devices the browser reads, each a `DomicileInputDevice` (name, `/sys` path, id, USB or Bluetooth ids, kind, connection), from `ui::DeviceDataManager`. Sent on connect and when one is plugged or unplugged; `domicile list-inputs` reads it. An older engine ignores it |

- Only `crop` fills the `<app>` box, so client-side shadows are not drawn. An
  empty rectangle means the whole buffer or surface. `domicile_surface_submit`
  takes no crop.
- `released` stops the compositor from reusing a buffer viz is still sampling.
- **No BeginFrames.** A window's frame is submitted when its client commits,
  with a manual `BeginFrameAck`, so the engine asks viz for no BeginFrames and
  the compositor is not woken each vsync. Viz still sends one after a frame to
  deliver its timing, which becomes `presented`; the engine answers
  `DidNotProduceFrame` so the display does not wait for the window. Releases come with the frame's ack or
  `ReclaimResources`.
- `domicile_engine.h` is the full ABI, including the lifetime calls.

### Buffer import

The browser imports each dmabuf. The producer submits its own frames.

1. `domicile_surface_import_async` sends the dmabuf fds, DRM fourcc and layout
   over the existing socket and returns at once. The compositor holds the
   frame back until `imported` answers (`engine_imports.rs`), so a new buffer
   never stalls the Wayland thread.
2. The browser imports it the way `exo::Buffer` does
   (`components/exo/buffer.cc`). That code needs `aura::Env`, which only the
   browser has.
3. The browser returns a `gpu::ExportedSharedImage`: a mailbox, metadata and a
   verified sync token. It answers only once its GPU channel passes the
   image's creation token. The producer's frame reaches viz on another pipe,
   and viz could draw it before the GPU had made the image, leaving the
   window blank until it was replaced.
4. The producer calls `gpu::ClientSharedImage::ImportUnowned`, builds its own
   `viz::TransferableResource` and submits its own `CompositorFrame`.
5. Viz returns the resource through the producer's own sink, which fires
   `released`.

Decisions:

- **Broker the import over brokering a GPU channel.** A GPU channel
  (`viz.mojom.Gpu`, what a renderer gets) would give an external process
  unrestricted GPU authority and pull the `gpu::` client stack into the
  library. Brokering the import costs one hop per buffer, and buffers are
  imported once per surface and reused. An import belongs to its surface, so a
  buffer committed to two surfaces is imported for each.
- **The producer submits its own frames.** It holds `gpu::` and `viz::` types,
  but no GPU channel. A mailbox lets the producer sample an existing image. It
  cannot create new ones. This takes the browser off the per-frame path.
- `ImportBuffer` refuses a DRM fourcc it cannot map. Guessing swaps color
  channels (`ARGB8888` vs `ABGR8888`).
- **A buffer's color is fixed at import.** Viz reads a resource's color space
  from its SharedImage, so `ImportBuffer` takes the surface's color space and
  the producer puts its HDR metadata on the resource. A surface whose color
  changes has its buffers imported again (`engine_imports.rs` keys an import
  on the color too).

### Display capture

A monitor is the composited output, which only viz has. The compositor casts
it from frames the browser captures ([PORTALS.md](../PORTALS.md)).

1. `domicile_display_capture_start` asks the broker (`CaptureDisplay`) for a
   display. Zero names a nested or headless browser's only window.
2. The browser finds the window whose rectangle is the display's
   (`display_capture_target.cc`) and runs a viz `FrameSinkVideoCapturer` on
   its root frame sink (`display_capture.cc`). Damage-driven, capped at
   `max_fps`, at the size the compositor asks for.
3. Each frame is a dmabuf when the browser composites on the GPU, shared
   memory otherwise. It crosses the broker socket opposite to client buffers,
   and `captured` lends the compositor its fds.
4. `domicile_captured_frame_release` gives the buffer back to viz.

The capture is the window's root frame sink, so a hardware cursor plane is not
in it. The compositor draws the pointer from its own state.

A browser window is captured the same way, on its page's own frame sink
instead of a root one. `domicile_browser_window_capture_start` asks the broker
(`CaptureBrowserWindow`) by the shell's window id. //chrome finds the page and
its size in pixels (`browser_window_capture_target.h`). Nothing the shell draws
over the window is in the frames.

## Key decisions

- **`SurfaceLayer` over `cc::LayerTreeHost` changes.** The alternative was a
  privileged "bind dmabuf to texture" path and per-layer depths in cc. cc
  already draws foreign surfaces for every page with an out-of-process iframe.
- **Domicile stays an external Rust process, not an in-tree `exo`.** exo is
  `assert(is_chromeos)`, depends on `//ash`, `//chromeos/ui/*`, `//ui/aura`,
  `//ui/views` and `//ui/wm`, and is one `static_library` with no separable
  core. Only `buffer.cc` is useful, and the import above ports it into the
  browser.
- **The library is C++ behind a C ABI, not a Rust mojom crate.** Chromium's Rust
  mojo bindings exist but cannot reach a cargo build.
  [ENGINE-FORK-CHROMIUM-NOTES.md](ENGINE-FORK-CHROMIUM-NOTES.md#rust-mojo-bindings)
  has the details.
- **`<app>` is a real element.** Patch `0007` defines `<app>` and `<webview>`,
  at the cost of eleven edited files, many of them generated lists that rebase
  noisily. In return a shell writes a tag with `app-id` reflection and default
  styling, and the SDK supplies only the tag-name map.
- **The browser leaves keys, clicks and credentials to the shell.** See
  [ENGINE-BROWSER-BEHAVIOR.md](ENGINE-BROWSER-BEHAVIOR.md), which also covers
  inhibiting the host's shortcuts when nested.
- **Minimize edited files, not added ones.** New files do not conflict on
  rebase. The generated lists (`runtime_enabled_features.json5`, the `json5`
  name lists, `.gni` bindings lists, `BUILD.gn` source lists) are what
  conflict. Count edited files from the patch headers (see the
  [package README](/packages/domicile-engine/README.md#why-a-patch-series)).

## Plan

Ozone/DRM is tracked in [A-DESKTOP-ON-A-TTY.md](A-DESKTOP-ON-A-TTY.md). Open
items:

- [x] **shm clients on a GPU.** The compositor copies each shm frame into one
      of its own GBM buffers (`packages/domicile-compositor/src/uploads.rs`)
      and submits it like a dmabuf. The compositing guards drive a `wl_shm`
      client on `crux`'s render node
      ([WINDOW-COMPOSITING.md](WINDOW-COMPOSITING.md#wl_shm-clients-on-a-gpu)).
- [ ] **Presentation, measured.** Every measurement reads pixels from
      a `CopyOutputRequest`. Nothing reads a lit CRTC yet, so overlay
      promotion, damage and the presentation half of latency are unmeasured.

## Open questions

- **Input hit testing.** `SurfaceLayer::SetSurfaceHitTestable` and viz hit
  testing exist, but Domicile routes input itself. Recommendation: keep
  Domicile's routing, with the page reporting the box. Unknown: whether viz's
  hit-test data must agree with Domicile's to keep the engine from swallowing
  events.
