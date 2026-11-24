# Displays on a tty

How the compositor arranges the monitors the engine scans out on. Overview:
[A-DESKTOP-ON-A-TTY.md](architecture/A-DESKTOP-ON-A-TTY.md#outputs).

## Where the display list comes from

| Source | Constructor | Decided by |
|---|---|---|
| `output.displays` | `Screens::described` | the config |
| `output.profiles` | `Screens::from_the_layout` | the config, matched against what DRM reports |
| the engine's reading | `Screens::from_the_engine` | the hardware, when no profile matches |
| Domicile's own window | `Screens::following_the_window` | the host, on a nested run |

- `Screens::replugged_into` picks the source on a hotplug. `output.displays`
  always wins over DRM.
- A hotplug rearranges outputs instead of recreating them.
  `Screens::rearranged_into` matches by `wl_output` name, so clients stay on
  their output.
- An engine reading whose displays overlap is skipped when no profile matches
  and none was in force. `DrmScreen` updates its display list one display at a
  time and the engine reports after each step, so mid-update lists can stack a
  new monitor on another. The last report of each update is laid out.
- A config reload re-matches profiles against the last engine reading
  (`engine_displays`, `Screens::reloaded_into`). This lets a profile take effect
  as soon as it is saved.

## Profiles

A profile names the displays it is for. The first profile whose displays are
all plugged in wins. This is kanshi's model.

```json
{
  "output": {
    "profiles": [
      {
        "name": "home-office-full",
        "displays": [
          { "display": "drm-1", "enabled": false },
          { "display": "drm-2", "position": [0, 0], "scale": 1.2, "transform": "rotate-270" },
          { "display": "drm-3", "position": [1800, 0], "scale": 1.2, "transform": "rotate-270" }
        ]
      }
    ]
  }
}
```

- Matching and placement are in `domicile-config`'s `profile.rs`.
- An entry without `position` goes in a row right of the positioned entries,
  in profile order, level with their top. With none positioned the row starts
  at the origin. The row uses each display's logical size and is recomputed
  with every layout, so it follows mode changes. This matches how the engine
  places unnamed connectors (`OriginsForLayout`).
- `scale` is fractional. `wl_output` sends it rounded up, and `xdg_output`
  reports the real logical size.
- `mode = [W, H]` asks for a mode, and `refresh` (Hz) for a rate. The layout
  is made at the requested mode, so positions that add up mode sizes come out
  as written. `Layout::of` refuses a size the monitor does not advertise with
  `ConfigError::Validation`, naming the ones it does, and a reload keeps the
  running desktop.
- The engine picks the mode in `ModeForLayout` (`drm_screen.cc`), as sway's
  `output mode` does: among the advertised modes of the size asked for (the
  native size when only `refresh` is given), the rate nearest `refresh`, or
  with none the native mode at the native size and the fastest at any other.
  Progressive modes win over interlaced ones. A size it does not advertise
  falls back to native. The modeset and the display list both use it, so the
  window still matches its CRTC.
- An engine reporting no modes (one older than `moded_displays`, or a nested
  desktop) cannot set one. There `mode` is a check, as it used to be: the
  profile applies only while the monitor is at it.

## Which connectors light

`Layout::scanout` tells the engine which connectors to light and where. The
config lives in the compositor and DRM master in the browser, so it crosses:

```
Layout::scanout  →  Screens::scanout  →  domicile_displays_configure
  → FrameSinkBroker.ConfigureDisplays  →  OzonePlatform::SetDomicileDisplayLayout
  → DrmModeset::SetLayout              →  ModesetParamsFromSnapshots
```

Rules:

- **Empty layout:** the hardware decides. Every connector lights, in one row in
  connector order. This also undoes a profile that turned a panel off. The
  desk spans the row, each display at its CRTC rectangle and scale 1, as
  `Screens::from_the_engine` advertises it.
- **Blank:** every connector listed with `enabled: false`. The desk stays as it
  was ([IDLE.md](IDLE.md)).
- **A sleeping connector** is listed with `enabled: false` and a `desk`. It
  keeps its place on the desk page but shows nothing
  ([IDLE.md](IDLE.md#one-monitor)).
- **A connector turned off is modeset with no mode**, which turns its CRTC off.
  Left out of the modeset, it would keep scanning out its last frame.
- **Non-empty layout:** a connector the layout does not name is turned off. This
  happens only to a monitor plugged in after the compositor built the layout.
  The next layout lights it.
- **Every connector gets its own origin.** Unnamed connectors go past the right
  edge of the named ones, in connector order (`OriginsForLayout`). ozone gives
  a new connector `(0, 0)`, which would stack monitors on one rectangle.
- **Primary is the first lit display.** The browser's first window goes to the
  primary display, so a dark primary means a black desktop.
- **Connectors follow the profile's placement order**, not connector numbers.
- **Each connector takes its mode size** on the engine's desktop, not its
  logical size.
- **All connectors sit in one row.** Nothing draws across connectors, so the
  row is invisible to the user.

## Pointer crossing

Patches `0050` and `0052` move the pointer between monitors in
`DrmCursor::MoveCursor`. Upstream clamps it to the current window. The math is
`ui/ozone/platform/drm/domicile/drm_pointer_crossing.h`, with tests.

- The layout carries each lit display's rectangle on the shell's desktop
  (`desk`). The pointer leaves by any edge and lands at the same desktop
  position, as in sway.
- A dark connector is never entered. With no layout, the engine's own desktop
  is used.
- A gap of up to one logical pixel counts as touching, because profile
  positions round outward.
- Edges are read in the monitor's rotated frame, using `CursorController`'s
  rotation.
- All pointer and key events go to the desk's host window
  (`OzonePlatform::SetDomicileDeskHost`, `PointerInWindow`).

## Tablets and touchscreens

`input.pointers` binds each tablet, touchscreen or absolute mouse to one
display. Config: [SHELL-CONFIG.md](SHELL-CONFIG.md#tablets-and-touchscreens).

- **Absolute mouse:** absolute X and Y, `BTN_LEFT` and `BTN_RIGHT`, and no
  `BTN_TOUCH`, pen or input property (`EventDeviceInfo::HasAbsoluteMouse`,
  patch `0123`). QEMU's USB tablet is one, and QEMU gives each head its own.
- **Touchscreen:** any other device with absolute X and Y and no pen
  (`EventDeviceInfo::HasTouchscreen`), including one that clicks with
  `BTN_LEFT` alone.
  An unbound one covers the only display when there is one
  (`TouchTransformsFor`), and none when there are several.
- The compositor resolves each entry's `display` against the engine's last
  display report (`pointer_targets`) and sends device-to-display-id targets
  on every report and reload:

```
bind_the_pointers  →  domicile_pointers_configure  →  FrameSinkBroker.ConfigurePointers
  → OzonePlatform::SetDomicilePointerTargets  →  DrmPointerTargets
  → DeviceDataManager::ConfigureTouchDevices     (touchscreens)
  → DrmCursor::SetDomicileAbsoluteAreas          (absolute mice)
```

- `ui/ozone/platform/drm/domicile/drm_pointer_targets.h` has the mapping,
  with tests. A touchscreen or mouse hotplug reapplies the targets.
- A display's CRTC rectangle, unrotated, is what a device's range covers.

### Absolute mice

`AbsoluteMouseEventConverterEvdev` (`ui/events/ozone/evdev/domicile/`, with
tests) reads one as a mouse:

- A position moves the pointer onto the bound display, crossing windows. A
  move with no button held hovers.
- Every mouse button is a mouse button, remappable like any mouse's.
- The wheels scroll in 120ths of a notch, from `REL_WHEEL_HI_RES` and
  `REL_HWHEEL_HI_RES` where the device sends them.
- An unbound one covers the display the pointer is on, as a pen tablet does.

### Touchscreens

- Upstream sends a touch only to the window of the display
  `DeviceDataManager` binds its device to. Only ash binds one, so an unbound
  device's touches are dropped.
- `TouchTransformsFor` gives each bound touchscreen a transform onto its
  display.
- `DrmWindowHost` sends a bound touch to the desk's host, placed with
  `PointerInWindow` as the pointer is (patch `0122`).
- Touches move no pointer. A touchscreen's button down and up are a tap.
- A finger on a window reaches its client as `wl_touch`
  ([GESTURES.md](architecture/GESTURES.md#touchscreen)).

## Rotation

The modeset cannot rotate: `DisplayConfigurationParams` has no rotation field.
Rotation happens in the render tree, as on ChromeOS. Each monitor has its own
window so each can rotate and scale on its own.

| Piece | Role |
|---|---|
| `DomicileDisplayLayout` | Carries the profile's `transform` and `scale` |
| `DrmScreen` | Sets `rotation` and `device_scale_factor` on `display::Display`; `bounds` stay in CRTC pixels |
| `DesktopWindowTreeHostPlatform` (patch `0043`) | With `turns_windows_with_their_display` (DRM only), applies a root transform and passes a display transform hint, so viz rotates the frame on output. Screen rectangles stay in pixels (patch `0045`) |
| `CursorController` | Built off ChromeOS so `DrmCursor::MoveCursor` rotates pointer motion. `DrmWindowHost` updates it |
| `wm::CursorLoader` | Rotates and scales the cursor image, the desk's theme (patch `0125`) as well as Chromium's art |
| `content::WebCursor` (patch `0171`) | Rotates a page's own cursor image (CSS `cursor: url(...)`) by the pointer's monitor, where `CursorFactory::ShowsCursorsUnturned` (DRM only) |

- A window is the monitor's logical box, upright. A 4K panel rotated at scale
  1.2 is a window of 1800×3200 DIPs.
- Each `<app>` element passes its scale (patch `0044`, `configure_at`) so the
  compositor can convert the box from the page's device pixels to the logical
  pixels a configure uses.
- `rotate-270` turns content a quarter clockwise, for a panel on its left side.
  This matches `wl_output` and kanshi. `RotationOf` in `drm_screen.cc` converts.
- A rotated monitor's capture is upright. viz captures the window's frame
  before it turns it for the panel, so screenshots and monitor and region
  casts read it as they read any other monitor.
- The pointer in a cast is upright too. `DrmCursor` turns the image it hands
  the casts (`desk_cursor`) back by the rotation of the panel it is on
  (patch `0163`).
- A client that pre-rotates its buffer for a rotated panel
  (`wl_surface.set_buffer_transform`) is shown and cast upright. See
  [WINDOW-COMPOSITING.md](architecture/WINDOW-COMPOSITING.md#pre-rotated-buffers).

## Shell windows

Each display gets its own browser window, and one shell page spans them all:
[ONE-PAGE-FOR-THE-DESK.md](architecture/ONE-PAGE-FOR-THE-DESK.md). On a
hotplug, sleep or wake that moves the host, `ShellWindows` moves the host's
window to the new host rather than reopening it, which would reload the shell.
It opens new windows before closing old ones and never closes the last window,
since that would exit the browser. A new window is created asynchronously, so
`ShellWindows` reconciles again once it exists to watch its page.

## Monitor names

A monitor's `wl_output` name is:

- `drm-<id>` when its EDID gives a make, model or serial;
- its connector otherwise, as the kernel and sway name it: `DP-1`,
  `HDMI-A-1`, `eDP-1`.

A profile's `display` matches any of:

- the `wl_output` name;
- the connector, `DP-1`;
- the description, `"<MAKE> <MODEL> <SERIAL>"`, as kanshi and sway use;
- the description with the maker's full name.

Example: `Dell Inc. DELL U3219Q 2ZLS413`, `DEL DELL U3219Q 2ZLS413` or
`drm-<id>`. Without hwdata's PNP table, the description uses the three-letter
code and the compositor logs one line at startup.

- The label travels as `display::Display::label` → the mojom `Display` →
  `const char*` on `DomicileDisplay`.
- The GPU process names the connector
  (`ui/ozone/platform/drm/domicile/connector_name.cc`). It travels as
  `display::DisplaySnapshot::domicile_connector` → `DrmScreen::connectors()`
  → `OzonePlatform::GetDomicileConnectors` → the mojom `Display` →
  `DomicileConnectedDisplay::connector`. `display::Display` has no field for
  it.
- `ui/ozone/platform/drm/domicile/edid_name.cc` reads the serial from the EDID.
  `display::EdidParser` keeps only a hash, and the serial is what tells
  identical monitors apart. The file uses no Chromium types, so it is tested
  outside a Chromium tree.
- `packages/domicile-compositor/src/pnp_ids.rs` expands the maker code from
  hwdata's `pnp.ids`, read at startup from `DOMICILE_PNP_IDS` (set by the
  flake's wrapper) or the distribution's path. It is read at run time because
  the table is GPL-2+ and this repo is MIT OR Apache-2.0.
- An engine without `connected_displays` reports no connector, so the
  compositor names every monitor `drm-<id>`.

## Physical size and refresh

- The browser process, and so the compositor, learns about a display only
  through `display::Display`.
- `display::Display` has a refresh rate but no physical size. `DrmScreen`
  stores the millimeters as `pixels_per_inch`, and
  `components/domicile/browser/display_list.cc` converts back with
  `display::kInchInMm`.
- `DomicileDisplay` carries both fields. Zero means unknown, as in
  `wl_output`.
- `DisplayList::UpdateDisplay` does not copy either field, and a profile can
  change a listed monitor's mode. So `DrmScreen::panels`, lent through
  `OzonePlatform::GetDomicilePanels`, carries each display's advertised modes,
  the rate it scans out at and its millimeters, and `DisplayListFor` takes
  them over the `display::Display`'s own.
- The modes reach the compositor through `moded_displays`
  (`DomicileModedDisplay`), and a profile's mode and rate go back through
  `domicile_displays_configure_modes`. The rate reaches `wl_output.mode` and
  the SDK's `Display.refreshMhz`.
- `DisplayList` notices neither a new rate nor a new adaptive sync state, so
  `DrmScreen` tells the display observers itself when a panel's changed
  (`PanelChangedUnseen`). Otherwise a modeset that changed only those would
  never reach the compositor.

## Adaptive sync

A profile entry with `"adaptive_sync": true` asks for a variable refresh rate
(adaptive sync, FreeSync, G-Sync Compatible): a frame that runs late is shown
as soon as it is ready rather than at the next fixed refresh. It is off by
default.

- `DrmModeset` asks for it, as `DisplayConfigurationParams::enable_vrr`, only
  where the snapshot says the connector can: the connector has `vrr_capable`
  and the EDID gives a minimum rate. Chromium's DRM platform then sets the
  CRTC's `VRR_ENABLED` in the modeset commit.
- A modeset that asked for it and was refused is asked again without it, as
  sway does. That monitor is not asked again until it is unplugged
  (`DrmModeset::adaptive_sync_refused_`).
- What a display reports is what the hardware says, read off the CRTC when
  the displays are read, not what was asked for. A modeset that turns it on
  or off reads the displays again so the report follows.
- It reaches the compositor through `adaptive_displays`
  (`DomicileAdaptiveDisplay`), and the request goes back through
  `domicile_displays_configure_adaptive`. The shell sees it as
  `Display.adaptiveSync`: `unsupported`, `off` or `on`.
- The browser still draws at the monitor's nominal rate. Adaptive sync helps
  when a frame is late, not by drawing at a lower rate when nothing moves.

## Bit depth

A panel scans out in 10 bits a channel when its EDID reports at least 10 and
its planes take `XB30` or `XR30`; otherwise in 8. There is no setting.

- The browser draws its frames in `RGBA_1010102` (or `BGRA_1010102` on planes
  with only `XR30`) (`DrawInTenBitsWhereThePanelTakesThem` in
  `drm_screen.cc`).
- `DrmDisplay` raises the connector's `max bpc` to 10, so the link carries
  10 bits instead of a dithered 8 (patch `0210`).
- `ten_bit_scanout.cc` decides both. The plan for HDR on top of it:
  [COLOR.md](/docs/architecture/COLOR.md).

## HDR

A profile entry with `"hdr": true` drives that monitor in HDR10: BT.2020
primaries with the PQ curve. It is off by default, and `sdr_white` sets how
bright SDR content's white is there (203 cd/m², BT.2408's reference white, if
absent).

- A monitor takes it when its EDID's HDR static metadata lists PQ and it
  scans out in 10 bits ([above](#bit-depth)). `hdr_output.cc` decides, and
  `DrmModeset` and `DrmScreen` both ask it, so the GPU process and the browser
  agree.
- `DrmModeset` asks for it as `DisplayConfigurationParams::domicile_hdr`. Once
  the modeset commits, `DrmDisplay::DomicileSetHdr` sets the connector's
  `Colorspace` to BT.2020 RGB, its `HDR_OUTPUT_METADATA` to PQ with the
  panel's luminances, and the planes' output primaries to the panel's (patch
  `0216`). Upstream does this only on ChromeOS, from the snapshot's color
  space.
- `DrmScreen` gives the display HDR10 color spaces with SDR white at
  `sdr_white` and headroom up to the panel's peak (`HdrColorSpaces`), so viz
  composites in PQ and maps SDR content to that white. A panel that reports
  no peak is taken to reach 1000 cd/m².
- It reaches the compositor through `hdr_displays` (`DomicileHdrDisplay`):
  `unsupported`, `off` or `on`, the panel's luminances, and the SDR white in
  use. The request goes back through `domicile_displays_configure_hdr`.
- The shell sees it as `Display.hdr` (`unsupported`, `off` or `on`),
  `Display.peakLuminance` (cd/m², zero when the EDID reports none) and
  `Display.sdrWhite` (cd/m² while on, zero otherwise).

## DisplayLink docks

- `evdi` hands DisplayLinkManager each page flip's `FB_DAMAGE_CLIPS`, and it
  compresses that rect on the CPU. Its load follows how much of the screen
  changes.
- Each flip names its own frame's damage, on its plane's own device (patch
  `0204`). Upstream sent no clip without ChromeOS's PSR2 flag, so evdi marked
  the whole screen changed on every flip.
- No gamma table, so the night light is a color matrix
  ([below](#with-no-gamma-table)), and `wlr-gamma-control` clients are refused.
- Planes take only 8-bit formats, so a dock's monitors scan out in 8 bits.

## Night light and gamma control

Each monitor draws with its own gamma ramp. Two things set one:

- **The night light.** The shell sets a color temperature for every monitor,
  or for one by its display `name`. Every monitor's replaces each one's.
- **A `wlr-gamma-control` client,** such as gammastep or wl-gammarelay-rs. It
  sets one monitor's whole ramp, so it can warm, dim or curve each monitor
  apart.

Who owns a ramp (`domicile-compositor/src/gamma.rs`):

- A client holding a monitor owns its ramp. The night light doesn't apply
  there, so the two never multiply.
- Every other monitor draws with its night light.
- When the client lets go or exits, its monitor goes back to its night light.
- One client per monitor; a second gets `failed`.

```
set_color_temperature {kelvin, display?}  ─┐
zwlr_gamma_control_v1.set_gamma            ─┴→  gamma::Ramps  →  domicile_displays_set_gamma
  → FrameSinkBroker.SetGamma  →  OzonePlatform::SetDomicileGamma  →  DrmModeset::SetGamma
  → NativeDisplayDelegate::SetGammaAdjustment
```

- `kelvin` is 1000 to 6500. 6500 is neutral: an identity ramp. An empty
  curve would leave the last ramp on the CRTC.
- A new night light fades in from the one drawn
  (`domicile-compositor/src/night_light.rs`), on ramps and color matrices
  alike. The fade takes 2.5 s per whole step of the gain that changes most:
  about 1.5 s to switch on at 3000 K, a few frames for each 15 s step of a
  schedule's ease. The compositor sends a ramp or matrix every 16 ms during a
  fade and nothing between fades. A `wlr-gamma-control` client's ramp is
  drawn as it sets it.
- A gamma ramp, not a color matrix, so it works on drivers without a CTM.
- A client is told the CRTC's own ramp size: `GAMMA_LUT_SIZE`, or the legacy
  ramp's. The GPU process reads it into each display's report
  (`DomicileRampedDisplay.gamma_size`).
- A client on a monitor with no gamma gets `failed` at once: a DisplayLink
  dock, a nested or headless desktop. So does a client whose monitor is unplugged.
- A table that isn't three ramps of the advertised size is the
  `invalid_gamma` protocol error. The fd is read without waiting, as wlroots
  does.
- A lit monitor takes a new ramp with its next page flip (patch 0161). So
  the broker then redraws the browser window showing that monitor
  (`RedrawDisplay`), and a still screen warms at once rather than when
  something next changes.
- `DrmModeset` sets each monitor's ramp again after each modeset, so a VT
  switch or resume keeps it. The compositor sends every ramp again after each
  display report, which covers a hotplug and an engine restart.

### With no gamma table

A monitor on a connector whose CRTC has no gamma (`GAMMA_LUT_SIZE` 0, as
`evdi` on a DisplayLink dock) draws its night light through the color matrix
[below](#in-hdr), as in HDR. A display on no connector (nested) is left to the
host compositor.

The cursor plane skips that matrix, and a white pointer on a warm screen looks
blue. So the pointer on a monitor drawn through a matrix, with no gamma or in
HDR, is warmed by the matrix's gains (patch `0269`): the broker sends them with each matrix
(`OzonePlatform::SetDomicileCursorTint`), and `DrmCursor` scales the pointer
image's encoded channels by their 2.2nd roots, as a ramp would. The broker
refuses a matrix whose diagonal is outside 0 to 1. On every other monitor the
CRTC's ramp warms the cursor plane with the rest.

### In HDR

A ramp scales the values the CRTC sends, and in HDR those are PQ-encoded, so
a ramp there would bend the curve the panel decodes rather than warm the
light. So a monitor driven in HDR:

- keeps an identity ramp, and draws its night light through a color matrix
  instead: `domicile_displays_set_color_matrix` → `FrameSinkBroker.SetColorMatrix`
  → `ui::Compositor::SetDisplayColorMatrix` on the browser window showing it.
  Viz applies it to the whole frame in linear light (patch `0217`). Each gain
  is the ramp's raised to 2.2, so the night light looks the same in HDR as
  in SDR.
- refuses `wlr-gamma-control` clients with `failed`, since their ramps assume
  SDR. A client holding a monitor when it goes into HDR is let go the same way.
- Every other monitor draws through the identity matrix, so leaving HDR
  undoes the night light's matrix.
- A nested desktop does nothing: the host compositor owns the screen.
- Sandboxed apps don't see the global.
