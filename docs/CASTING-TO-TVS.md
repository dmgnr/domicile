# Casting to TVs

The user picks a TV in the bar, then either extends the desktop onto it or
casts a window, a monitor or a region to it. v1 speaks Google Cast and
Miracast.

## Targets

| Receiver | Protocol | v1 |
|---|---|---|
| Chromecast, Google TV, Android TV, Nest Hub, TVs with Cast built in | Google Cast mirroring | yes, in the engine |
| Fire TV on Fire OS, Roku, Samsung, LG, Windows wireless displays | Miracast over Wi-Fi Direct | yes, `domicile-miracast` |
| LG webOS, Windows, Microsoft adapters | Miracast over the LAN (MICE) | yes, `domicile-miracast` |
| Apple TV, AirPlay TVs | AirPlay 2 | no |
| Smart TVs as DLNA renderers | UPnP AV | no |
| A TV running Moonlight | GameStream | no |

- **AirPlay is out.** Mirroring is FairPlay-encrypted and no open sender
  speaks it.
- **DLNA is out.** Renderers buffer for seconds; fine for a video file, not a
  desktop.
- Fire TV sticks on Vega OS (2025 on) may lack Miracast. No Fire TV has Cast.

## UX

- **`Cast` bar item** (`manganese-bar-module-cast`). Its popover lists the
  TVs found nearby, by name. Protocols are never shown. A TV that cannot be
  reached says why ("Needs Wi-Fi Direct"). Each other TV has two buttons:
  - **Extend.** The TV becomes a monitor at its mode, placed above the
    others and centered, so the pointer reaches it by going up. It shows in
    Settings > Displays like any monitor.
  - **Show…** The share picker opens, titled "Cast to <TV>". Whatever is
    picked (window, monitor, region) goes to the TV.
- **Sound follows the source:** a window's own apps, or every app for a
  monitor or region ([audio.rs](/packages/domicile-compositor/src/casting/audio.rs)).
- **While casting,** the popover shows the TV, what is on it, and **Stop**. The shell holds off idle blanking through the
  Inhibit portal and holds notification banners, which the TV could show;
  notifications still reach the drawer
  ([cast-holds.ts](/packages/shell-manganese/src/cast-holds.ts)).

## Design

Both backends take their picture from the ScreenCast portal. Neither touches
the compositor's casting code.

```
bar item ──casting(host).start(target, Extend | Pick)──▶ backend (engine Cast / domicile-miracast)
                                                  │ ScreenCast portal
                                Pick: share picker │ Extend: shell answers with virtual-N
                                                  ▼
                                    compositor casting/ ── PipeWire video + sound nodes
                                                  ▼
                                    backend encodes, sends to the TV
```

- **Extend** creates a virtual monitor, then starts the cast. The shell
  answers the backend's ScreenCast request with that monitor, so no picker
  shows. Restore tokens are per app, so they can't do this. Stopping the cast
  removes the monitor.
- **Show…** starts the cast and the share picker asks.
- **The SDK** (`@domicile-desktop/sdk/cast`): each backend is a
  `CastBackend` (`watchTargets`, `send`, and the app id its portal requests
  carry). `casting(host).start(backend, target, CastMode.Extend |
  CastMode.Pick)` starts a cast and `watch` lists them. `<PortalDialogs />`
  asks `claimCastRequest` of each ScreenCast request: Extend's is answered
  with its monitor, Pick's picker is titled for the TV. The bar item merges
  every backend's TVs.

### Virtual monitors

- The shell asks for one with `SystemRequest::VirtualMonitor { name, mode }`.
  The reply names its `wl_output`. It lives until the request ends (`Unwatch`, or the shell's page going away).
- `SystemRequest::ResizeVirtualMonitor`, under the same id, resizes it in
  place: same id, `wl_output`, windows and casts. A monitor cast
  renegotiates its size.
- Both take a `scale`, 1 when left out, which `Screens` gives its
  `wl_output` and the display layout.
- The compositor sends the list to the engine with
  `domicile_virtual_displays_configure`. Each has an id the compositor picks.
- The engine adds a `DisplaySnapshot` of type `NETWORK` for each to the DRM
  reading, with connector `virtual-<n>`. `DrmScreen` lists it like any
  display; `ModesetParamsFromSnapshots` skips it, so no CRTC lights.
- `Screens` places it on the other monitors' top edge, centered, whatever
  profile matched, moving them down to make room. Several sit in one row. The
  engine only lays out a row, so the compositor sends the layout itself. A
  headless desk of virtual monitors alone stays the engine's row.
- A tty session only. Nested, the window is the desktop, so Extend is
  unavailable.
- The browser opens a desk window on it as on any display. Its GPU window has
  no controller, so frames are acked without scanout, paced by viz's
  synthetic begin-frame source at the receiver's rate.
- The engine's display capture reads it like a real monitor, so monitor casts
  of it need no change.

### Google Cast, in the engine

- Chrome's Media Router discovers receivers (`_googlecast._tcp`) and runs
  mirroring (`components/mirroring`, `media/cast`, Open Screen).
- `CastSinks` (`cast_sinks.mojom`), a browser pipe beside `BrowserWindows`,
  bound for the shell's origin only. It lists the TVs that take a desktop
  (`domicile.castSinks`, `castsinkschanged`) and starts and stops routes
  (`startCasting`, `stopCasting`). Listening starts discovery. The SDK
  types it as `domicile.googleCast`.
- A cast's source is the whole desktop, already chosen, so the Media Router
  skips Chrome's picker (patch `0141`).
- Mirroring captures through webrtc's PipeWire capturer, which asks the
  portal (patch `0128`). The engine's portal app id is not its own pick, so
  `engineCast` claims the next ScreenCast request from any app.
- Each cast's desktop has a new screen id. webrtc keeps the portal's restore
  token per id, so a reused id would restore the last pick and never ask the
  shell.
- Patch `0150` letterboxes a capture of another shape in black. Upstream left
  the bars as zeros, which is green in I420.

### Miracast, `domicile-miracast`

- `packages/domicile-miracast`: a Rust D-Bus service, `net.domicile.Miracast`
  on the session bus, which D-Bus starts on the shell's first call as the
  user unit `domicile-miracast.service`. That unit is `PartOf=` and
  `Requisite=graphical-session.target`, so it ends with the desk. The SDK's
  `miracastCast(domicile)` reaches it through `domicile.dbus`, so it needs no
  protocol frames.
- **API** (`net.domicile.Miracast1` at `/net/domicile/Miracast`): `Sinks()`
  and `SinksChanged`; `Cast(id)`, which returns a cast id at once, then
  `Started(cast)` once the TV plays or `Ended(cast, reason)`; `Stop(cast)`.
- **Discovery and links:** NetworkManager's `WifiP2P` D-Bus API for Wi-Fi
  Direct, connecting with the source's WFD IEs; Avahi browsing
  `_display._tcp` for MICE, which is told `SOURCE_READY` over TCP 7250.
- **Order of a cast:** the portal's picture first, so a cancel in the share
  picker touches no Wi-Fi; then the link; then the TV opens RTSP to TCP 7236.
- **Session:** the WFD source side of RTSP (M1 to M8, M16 keepalives), then
  RTP carrying MPEG-TS. 1080p30, 720p30, 720p60 or 640x480p60, whichever the
  TV plays first.
- **Media:** `gst-launch-1.0`, `pipewiresrc` to H.264 (VA-API, else x264) and
  AAC from the default sink's monitor, into `mpegtsmux`. A separate process,
  so a broken plugin ends only the cast.
- **Failures say why:** a TV that never connects back names the firewall
  port; a TV that does not accept, or refuses RTSP, says so. Under `iwd`, or
  without a P2P-capable card, NetworkManager has no Wi-Fi Direct device, so
  only LAN TVs are listed and the service logs why.
- GNOME Network Displays is the reference. It is GPL-3, so nothing is copied.

## Key decisions

- **Extend or Pick over a single mirror mode.** Pick covers a single window,
  native or web; native windows are in every monitor frame because `<app>`
  draws them in the page.
- **Cast in the engine over a standalone sender.** Chrome already ships
  discovery, the Cast channel, encoders and congestion control, and a page's
  Cast button comes with it.
- **The portal as the only source.** Both backends see what any portal app
  sees, so the share picker is the whole source API.
