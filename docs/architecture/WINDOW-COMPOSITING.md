# How a window reaches the screen

A Wayland client's window is a `cc::SurfaceLayer` in the shell's page. Why the
engine is forked: [ENGINE-FORK.md](ENGINE-FORK.md#problem).

```
  wayland client ──dmabuf──▶ domicile-compositor ──CompositorFrame──▶ viz ──┐
                             (Smithay server, viz producer)                 │ aggregates
                                                                            ▼
  the page: <app> ──SurfaceLayer(SurfaceId)──▶ cc layer tree ──▶ viz ────────┴─▶ display
```

1. The browser imports the client's dmabuf as a `SharedImage`.
2. The compositor adopts it with `gpu::ClientSharedImage::ImportUnowned`.
3. The compositor submits a `CompositorFrame` with a `TextureDrawQuad` into a
   viz surface.
4. The page's `<app>` element embeds that surface.
5. Viz aggregates the page and the window into one display frame.

The CPU copies no pixels, and no frame crosses a socket.

Viz may promote a window's quad to direct scanout. Untested: `SCANOUT` requires
a buffer allocated for a display, and no test setup has one.

[ENGINE-FORK.md](ENGINE-FORK.md) covers the engine side and
[ENGINE-FORK-MEASUREMENTS.md](ENGINE-FORK-MEASUREMENTS.md) the measurements.

## What each side knows

The page and the compositor share only a `viz::SurfaceId`.

- **The page sees no window pixels.** It lays out an `<app>`, and the
  element's layout box becomes the client's `xdg_toplevel.configure`. A shell
  cannot screenshot a window or draw anything derived from its contents.
- **The compositor sees no page layout.** It knows which app a surface belongs
  to, but not where it sits, what covers it, or what CSS applies.
- **The Wayland connection belongs to the engine.** Shell JavaScript cannot add
  requests to it. Messages from the page about a frame are not synchronized
  with that frame's commit.
- **Control-channel messages reach the page later than frames reach viz.** A
  popup's move is a message, so a page shows it a frame or more after the
  content it moved with, unless the page renders synced frames
  ([Synced frames](#synced-frames)). A subsurface's move is not a message:
  its window's frame draws it ([Subsurfaces](#subsurfaces)).

## Subsurfaces

A window's subsurfaces (`wl_subsurface`) are drawn inside the window's own
frame, as any other compositor draws them. They move, scale, clip and fade
with their window, whatever CSS the page gives its `<app>`, and the page never
hears of them. Firefox draws its whole window into one; Chromium draws its
extension popups and other bubbles as them.

```
 commit of a window (or of a desync subsurface, which redraws its parent)
   ├─ domicile_surface_set_children(window, [{sub, x, y, w, h, above}, …])
   └─ submit(window) ──▶ CompositorFrame: [subs above] [window's texture] [subs below]
                           each sub a SurfaceDrawQuad of its own sink's newest frame
```

- **Each subsurface is an engine surface** under an id the compositor gives
  it (`subsurface-N`), which the host never sees. Its commits submit to it at
  the newest box, as a popup's do.
- **The parent embeds it.** `domicile_surface_set_children` lists a surface's
  subsurfaces, bottom to top, in logical pixels from the top left of its crop.
  The parent's next frame registers each one as its child sink with the
  browser (`FrameSinkBroker::EmbedFrameSink`), allocates its `LocalSurfaceId`,
  and draws it with a `viz::SurfaceDrawQuad`. The engine then reports the
  subsurface's `configure`, after which it takes frames.
- **A change without a parent buffer** (a desync subsurface resized, hidden or
  destroyed) sends the parent's last frame again (`domicile_surface_redraw`).
  That frame answers no `frame_done` or `presented`.
- **Sync subsurfaces** show with their parent's commit: Smithay applies the
  transaction's commits children first, and the parent's frame embeds them.
- **Nesting:** a subsurface's own subsurfaces are its children in turn.
- **Input:** the chrome sends input for the window. The compositor finds the
  topmost subsurface whose input region holds the point (`subsurfaces.rs`),
  for the pointer and for a touch's down, as Smithay's
  `under_from_surface_tree` would. A subsurface that takes no input passes the
  point down.
- **Hidden:** Chromium hides a subsurface by destroying its `wl_subsurface`
  and keeping the surface. The compositor notices at the next commit of it or
  its parent.
- **Check:** `guard-scrolling-bubble.sh` scrolls a window under a sync
  subsurface on `crux` and reads a monitor cast: each frame shows the
  subsurface at the window's content. Its control moves the subsurface a
  frame late (`domicile-test-client --late-bubble`) and shows it off.

## Synced frames

A commit that moves a popup shows in the same display frame as the window
content it moved with. The commit goes to viz under a `LocalSurfaceId` the
compositor names, and the page embeds that id in the same render as the move.

```
 one commit transaction (parent + its popup)
   ├─ domicile_surface_sync(parent, n); submit ──▶ viz: parent at (p, 1+n)
   ├─ domicile_surface_sync(popup, m); submit  ──▶ viz: popup at (q, 1+m)
   │                                               (page still shows n-1, m-1)
   └─ PopupPlaced { position, frames: {parent: n, popup: m} } ──▶ page
                                                                   │
        one render:  <app app-id=parent frame=n>                 ◀─┤
                     <app app-id=popup frame=m style="left: …">  ◀─┘
```

- **Synced frame:** a number per surface, from 1. Frame `n` is the
  `LocalSurfaceId` the page allocated with child sequence number
  `kInitialChildSequenceNumber + n` (`components/domicile/common/synced_frame.h`).
  Frame 0 is the id the page allocated.
- **Producer:** `domicile_surface_sync(engine, surface, n)` makes that submit
  and every later one go up at frame `n` of the newest box. Viz accepts a
  child-sequence bump as monotonic, as for an OOPIF.
- **Embedder:** `<app frame="n">` embeds frame `n` of its allocated id, with
  the default deadline. Viz holds the page's frame until frame `n` activates.
  Until the page embeds it, viz draws the newest active surface not newer than
  the embedded id (`FindLatestActiveSurfaceInRange`).
- **The number rides the control channel,** not the embed pipe, since the
  page needs it in the same render as the move. The default deadline covers a
  message that beats its frame to viz.
- **A commit transaction is the unit.** For a sync subsurface, Smithay calls
  `CompositorHandler::commit` for each surface of the parent's transaction,
  children first. A popup's reposition is held (`synced_moves.rs`). Each app submit after it in the transaction is synced,
  and the transaction's last commit broadcasts the move with `frames`.
- **The compositor names a frame only after submitting it,** so a stuck client
  never holds the page. A dropped submit keeps its frame for the next one, so
  the page waits at most one deadline.
- **A stuck page holds synced client frames.** Viz acks a frame only when it
  is drawn or replaced, so the client's `wl_surface.frame` waits for the page
  or the 250 ms deadline ([Frame pacing](#frame-pacing)).
- **Resizes compose.** A resize allocates `(p+1, 1)`; the producer and the page
  both apply `n` to the allocated id. The page never calls `UpdateFromChild`.
- **Eviction:** viz garbage-collects only surfaces marked for destruction, and
  a sink's newest surface is not marked, so an unembedded frame lives until a
  newer one activates.
- **Opt-in:** `ChromeMessage::SyncFrames` (`domicile.windows.syncFrames()`), reset by
  the page's next `hello`. The compositor syncs only while every connected
  chrome has asked (`ChromeHub::syncs_frames`) and the engine has
  `domicile_surface_sync`. Unsynced commits go up at the newest frame.
- **A page that ignores frames:** an `<app>` with no `frame` attribute embeds
  the newest frame the control channel named for it (`domicile::KnownFrames`,
  fed by `AppAppeared.frame` and `PopupPlaced.frames`).
- **Reload:** `Host` keeps each surface's last frame, and `AppAppeared.frame`
  and a catch-up `PopupPlaced` tell a new page where each one is.
- **xdg popups:** a reposition (`xdg_popup.reposition`) is placed when the
  client commits the configure it acked, synced with that commit's frame and
  its sync subsurfaces'. The parent's content is not in the popup's
  transaction, so a popup and the window under it can show a frame apart.
- **Unchecked:** no guard reads a synced popup move off a screen since
  subsurfaces moved into their windows' frames, which is what
  `guard-scrolling-bubble.sh` checked.

## Anchored windows

A client can ask for its window to be laid out at a named place in the page,
such as a slot in a panel (`domicile_anchor_v1`,
`packages/domicile-compositor/protocols/domicile-anchor-v1.xml`). The page lays
it out with its own elements, so the window moves with them in the same frame.

```
 client: domicile_toplevel_anchor_v1.set_anchor("bar"); wl_surface.commit
   └─▶ compositor: AppAnchored { app_id, anchor: "bar" } ──▶ page
         window.anchor == "bar":  <div class="bar-slot"><app app-id=…></div>
```

- **Double-buffered:** the anchor applies on the window's next commit
  (`anchors.rs`). Set before the first buffer, it rides the window's
  announcement, right after `AppAppeared`, so the shell never places it
  elsewhere first.
- **Size:** unchanged. The `<app>`'s box becomes `xdg_toplevel.configure`, as
  for any window.
- **Names are the shell's.** A shell with no anchor of the name lays the window
  out as any other. `shell-manganese` defines none.
- **One object per toplevel.** A second `get_toplevel_anchor` while the first
  lives is `already_anchored`. Destroying it unanchors the window on its next
  commit.
- **Toplevels only.** Popups place themselves by their positioner.
- **Checks:** `tests/anchors.rs` (the announcement), `host.rs` (changes and
  replay), `ControlChannelTest.AWindowsAnchorReachesThePage` (the page's
  `DomicileWindow.anchor`).

## Frame pacing

A client draws its next frame when viz takes its last one, so it draws at the
rate the screen shows it.

- **`wl_surface.frame`:** a commit's callbacks wait for the engine's
  `frame_done`, viz's ack of the frame the commit submitted
  (`frame_callbacks.rs`).
- **`wp_presentation`:** a commit's feedback waits for the engine's
  `presented`, the frame's `FrameTimingDetails` from viz. The clock is
  `CLOCK_MONOTONIC`, synced to the output the window is on. `seq` is always
  zero: viz reports no vblank count.
- **Held frames:** a frame waiting for its buffer's import or for a page to
  embed its window has no number yet. Its commit's callbacks and feedback wait
  by window, and take the number the frame goes up with. A newer frame answers
  them and discards the feedback.
- **Frames viz never sees** answer at once and discard their feedback: an shm
  frame the compositor could not copy, a commit with no new buffer that
  leaves the window as shown, the chrome's own window.
- **Viz behind:** viz acks a frame when it takes it, not when it draws it, so
  a client can submit faster than viz draws. With 16 of a window's frames
  waiting for presentation, the engine holds the newest submit until viz
  reports one, and a newer submit replaces it, answered at once and discarded
  (`SurfaceBacklog` in `surface_submits.h`). Viz aborts past 25.
- **The deadline:** a frame the engine does not report within 250 ms is
  answered anyway and its feedback discarded, so no client waits for good.
- **Older engines** lack `domicile_engine_reports_frames`. The compositor
  answers at commit and discards feedback.
- **The page hears it too:** the compositor sends `app_presented` for the
  first `presented` frame of a new window or popup, and for the first one a
  client drew for a box of a new size (`presentations.rs`). The engine fires
  `domicile-presented` on the `<app>`.
  - The compositor owns this: it alone knows which commit answers which
    configure (`configure_answers.rs`).
  - A move or a hidden window shown again sends nothing: the client may not
    draw, so no frame of it is `presented`.
  - Unverified end to end: the compositor's tests run without an engine, and
    no check reads a lit CRTC.

## Commits without a buffer

A commit that attaches no buffer but changes the window's viewport, buffer
scale, buffer transform or geometry shows the buffer on screen again, mapped
anew (`EngineSession::remap`).

- **Size:** the chrome hears the new size (`app_resized`).
- **On screen:** the engine's held buffer, a client dmabuf or the
  compositor's shm copy, goes up again at the commit's box with the whole box
  damaged. The client's `wl_shm` buffer is not read again, and the hold stays
  one hold, so the client gets one release per attach.
- **Waiting:** a frame waiting for an embed or an import takes the new crop
  and box in place, and keeps its fence.
- **Not remapped:** a commit that only acks a new configure. The window keeps
  its old frame at its old box rather than stretching it.
- **Unsynced:** a remap goes up at the newest frame, as an unsynced commit.
- **Casts:** a window shot takes the new crop; a live window cast keeps the
  old one until the client attaches a buffer.
- **Checks:** `tests/apps.rs` checks the size the chrome hears. The resubmit
  is unchecked: the compositor's tests run without an engine.

## Hidden windows

A window the page does not draw (another workspace, a background tab) draws
about once a second, unless a cast shows it.

- **The page:** reports it with an empty box, `setAppBounds(appId, 0, 0, 0,
  0)`.
- **Suspension reaches the page:** each change sends `app_suspended`, and the
  engine fires `domicile-suspended` or `domicile-resumed` on the `<app>`.
- **The compositor:** holds the `wl_surface.frame` callbacks of the window,
  its popups and its subsurfaces (`held_frames.rs`), and sets `xdg_toplevel`'s
  `suspended` state. A box with an area clears `suspended` and sends the held
  callbacks.
- **Not stopped:** held callbacks still go out once a second, and before a
  close. A client blocked in `eglSwapBuffers` reads nothing else until one
  arrives: not a close, and not its other windows' events. At most 16 are
  held per window; a client that commits without waiting gets the oldest
  back.
- **Casts:** a hidden window that a cast shows holds nothing and is not
  suspended, so the cast keeps its frame rate (`HeldFrames::cast`). When its
  last cast ends, it is held and suspended again.
- **A new page** (`hello`) has hidden nothing, so every window is shown.
  Otherwise a shell that never reports boxes would leave them suspended.
- **Cost:** a window shown again can take a frame or two to appear. Its
  client starts its next frame only then. Manganese delays a closing tab's
  fade by as long, so the tab it uncovers is drawn first.
- **Theme changes** do not wait for hidden windows to repaint.

## What CSS does to a window

Anything that works on a hardware-composited `<video>` works on an `<app>`. Both
are the same layer type in the same property trees, so there is no list of
supported properties to maintain.

Measured against an ordinary element laid out beside it, an `<app>` matches
pixel for pixel on the GPU for `z-index`, `transform`, `border-radius`,
`opacity`, `filter: blur()`, `mix-blend-mode` and resize. See
[ENGINE-FORK-MEASUREMENTS.md](ENGINE-FORK-MEASUREMENTS.md#css-parity).

## Pre-rotated buffers

A client may draw its buffer turned to match a rotated monitor and say so with
`wl_surface.set_buffer_transform`. The engine turns it upright.

- **Compositor:** sizes the surface by the upright buffer, a quarter turn
  swapping its sides, and maps the window-geometry crop into the buffer's own
  pixels (`buffer_transform.rs`). Both dmabuf and `wl_shm` frames take this
  path; an shm frame is copied unturned (`uploads.rs`).
- **Engine:** `domicile_surface_submit_transformed` draws the quad in the
  buffer's orientation and gives it a `quad_to_target_transform` onto the box
  (`surface_transform.cc`). Viz turns it on the GPU, so no pixel is copied.
- **Older engines** lack the symbol. The compositor submits unturned and logs
  once when a buffer is turned.
- **Casts:** a window cast and a shot of one window turn the frame upright too
  (`Layer::upright` in `casting/gpu.rs`). The CPU copy maps each pixel as
  `buffer_transform.rs` does; the GPU draw gives Smithay the inverse transform,
  which its GLES frame expects. A turned frame's damage is the whole frame.
- **Checks:** `surface_transform_unittest.cc` maps each of the eight transforms
  as Weston does. `guard-buffer-transform.sh` shows a turned shm buffer upright,
  and `e2e-a-window-casts-to-pipewire.sh` casts one upright. No check covers a
  turned dmabuf, because none has a render node.

## What is open

### A sibling submitted before a move

A sibling surface submitted before a popup's move in the same commit
transaction goes up unsynced, so it shows a frame early.

### `backdrop-filter` over a window

Translucent chrome above an `<app>` should blur the window beneath it.

- **Why it should work:** `SkiaRenderer` applies the filter on the render pass
  that already contains the window's quad (`skia_renderer.cc:1785` at the pin).
- **Risk: overlay promotion.** A promoted quad is not in the render pass the
  filter reads. At the pin, viz does not promote a quad under a backdrop
  filter, except protected content (`requires_overlay`). Source references:
  [ENGINE-FORK-CHROMIUM-NOTES.md](ENGINE-FORK-CHROMIUM-NOTES.md#backdrop-filters-and-overlay-promotion).
- **The check:** `packages/domicile-engine/scripts/guard-css-and-resize.sh`
  (run by `packages/domicile-engine/scripts/check-css-and-resize.sh` on `crux`) reruns
  `spike-css-page.html` with `?backdrop-filter=`.
  - Each test cell shows an `<app>` next to a `<div>`. With the filter on, both
    halves must still match.
  - The last cell filters only the `<div>`, so a filter that does nothing
    fails.
  - The default filter is `invert(1)`. Blur spreads edge pixels into the
    compared area, so blur is measured only on hardware:
    `BACKDROP_FILTER='blur(8px)' GPU=1`.
  - Result: pending on `crux`.
- **Still open after the guard passes.** The guard runs headless and
  software-composited, where no quad is an overlay candidate. Testing that
  viz declines promotion needs a lit CRTC
  ([ENGINE-FORK.md](ENGINE-FORK.md#plan)).

### `wl_shm` clients on a GPU

A `wl_shm` client has no dmabuf. The compositor copies each frame into its own
GBM buffer and submits that (`uploads.rs`, `shm_upload.rs`).

- **Checks:** `guard-buffer-transform.sh` drives `domicile-test-client`, a
  `wl_shm` client, on `crux`'s render node (NVIDIA's proprietary driver), and
  finds its pixels on the page. That covers the GBM allocation and the
  browser's import: shm frames have no other path, and without a GBM device the
  window stays blank (`ShmRefused`). The copy is also tested on llvmpipe.
  - On Mesa (AMD, Intel) it is tested by hand, in daily use.
- The pixels pass through a texture kept on the surface. While it holds the
  previous commit in the same format, only the client's damage is uploaded.
  Smithay keeps a cached texture's format, so a new format at the same size
  skips the cache.
- **The copy is fenced, not waited for.** The compositor submits with the
  draw's sync_file (`domicile_surface_submit_fenced`). The browser gives the
  fence to the SharedImage (`FenceBuffer`, `UpdateSharedImage`) and returns a
  sync token, which the engine puts on the frame's resource. Viz waits on the
  token, and the GPU waits on the fence before the read.
  - The engine holds the surface's later submits behind a fenced one
    (`surface_submits.cc`), so frames reach viz in commit order.
  - Each fenced frame costs the browser one synchronous flush to the GPU
    process, to verify the token. Viz refuses an unverified one, and the
    engine has no GPU channel to verify it.
  - A refused fence drops the frame and releases the buffer.
- **The copy waits for the GPU on the Wayland thread** with an older engine,
  or a driver that cannot export a sync_file (no
  `EGL_ANDROID_native_fence_sync`).
- Unverified: a GPU process without `EGL_ANDROID_native_fence_sync` skips the
  fence's wait (`GLTexturePassthroughOzoneImageRepresentation::BeginAccess`),
  as for exo, and may show an unfinished copy. No check reads a lit screen,
  so torn shm frames on hardware are unmeasured.

### `wl_shm` clients on the CPU

An engine that composites in software reads only memory
([Software output](A-DESKTOP-ON-A-TTY.md#software-output)). With
`--software-compositing`, or once the engine says it composites in memory, the
compositor copies each `wl_shm` frame whole into
a memfd of the window's (`memory_frames.rs`) and imports it with
`domicile_surface_import_shm`.

- The browser makes the memfd a software SharedImage
  (`DomicileCreateSharedImageForSoftwareCompositor`, patch `0136`). Viz reads
  it without a copy.
- [`uploads.rs`](../../packages/domicile-compositor/src/uploads.rs) keeps a
  memfd out until viz releases it, as for GPU buffers.
- The whole frame is copied, since each memfd misses the frames shown from the
  others. A 1080p frame is 8 MB.
- The browser refuses a window in memory while it composites on the GPU.
- The compositor advertises no `zwp_linux_dmabuf_v1`, so GL clients fall back
  to `wl_shm` too.
- Window casts read dmabufs, so they miss these windows. Monitor casts read
  the engine's display capture and show them.

### Damage

The submit takes a damage rectangle in box pixels, where empty means the whole
box. `engine_damage.rs` maps the client's damage onto the box when the engine
shows the window's previous commit at the same box, from the same crop of a
buffer of the same size, and nothing turns either commit's buffer. Where the crop
is stretched to another size, as a `wp_viewport` at a fractional scale does,
the damage grows a texel each way for the engine's filtering.

- **Buffer damage** (`damage_buffer`, Chromium's) is already in buffer pixels.
- **Surface damage** is scaled, or mapped through the viewport's source
  (`client_damage.rs`). Under a destination with no source it is the whole
  buffer. Every other commit damages the whole box, as do popups and
subsurfaces, whose box size the compositor does not know.

Unverified on a screen: a wrong rectangle leaves stale pixels, and no check
reads a lit CRTC ([ENGINE-FORK.md](ENGINE-FORK.md#plan)).
