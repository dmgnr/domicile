# Hardware checks

Checks that need a machine with a lit panel. No agent or CI runner here has
one: `crux` has a GPU but no panel, and the container has no `/dev/dri`. Each
check is one run with a log line to look for. Run with `--vmodule=drm*=1` to
see the `configuring N display(s)` lines.

## Touchpad gestures

Unverified. On a tty with a touchpad, open Google Chrome with
`--ozone-platform=wayland --app=<a long page>`. Expect:

- a two-finger pinch zooms the page, and the shell around it stays put;
- a two-finger swipe right goes back, and left goes forward;
- a vertical two-finger scroll scrolls without navigating.

`RUST_LOG=domicile_compositor=trace` logs each `pointer_pinch` the compositor
gets. No line: the engine never saw the pinch.

In Manganese:

- a two-finger pinch over a browser window magnifies its page without
  reflowing it, and the shell around it stays put;
- a two-finger pinch over the bar or the empty desktop does nothing;
- Meta+pinch, and Meta+two-finger scroll, magnify the whole screen around the
  pointer, over a browser window, a native app and the empty desktop alike.

In Manganese with windows on two workspaces of one monitor:

- a four-finger swipe left goes to the next workspace, and right to the
  previous one;
- a four-finger swipe down pulls the scratchpad down, and up puts it away;
- with the scratchpad away, a four-finger swipe up opens the overview, and
  down closes it without pulling the scratchpad down;
- spreading three fingers opens the launcher, from the overview too, and
  again closes it;
- pinching four fingers in opens the overview, spreading four closes it, and
  pinching in again inside it does nothing;
- with two windows side by side, a three-finger swipe right focuses the right
  one, and left the left one;
- a three-finger swipe does not scroll the window under the pointer;
- with `WAYLAND_DEBUG=1 gtk4-demo 2>&1 | grep -E 'swipe|hold'` running, a
  five-finger swipe over its window logs a swipe `begin`, `update`s and an
  `end`, and resting three fingers logs a hold `begin` and `end`; a
  four-finger swipe logs nothing and changes workspace.

## Touchscreen

Unverified. On a tty, on a laptop's own touchscreen with no config, and with
an external monitor too once the touchscreen is bound in `input.pointers`
([Tablets and touchscreens](DISPLAYS.md#tablets-and-touchscreens)):

- in a GTK or Qt app, a finger drag scrolls or selects as on any Wayland
  desktop, and a two-finger pinch zooms where the app supports it;
- in Google Chrome with `--ozone-platform=wayland`, a finger drag scrolls the
  page and a pinch zooms it, and the shell around it stays put;
- `xeyes` under Xwayland, or another client without touch, follows the first
  finger as the pointer, and a tap clicks;
- a finger on the shell outside every window works as before.

In Manganese with windows on two workspaces of the touchscreen's monitor:

- a swipe in from the right edge goes to the next workspace, and in from the
  left edge to the previous one, and the window under the finger never
  scrolls;
- a scroll that starts at the very edge of a window still scrolls it, a
  moment late;
- a tap on a button at the very edge of a window still presses it.

`RUST_LOG=domicile_compositor=trace` logs each `touch` line the compositor
gets. No line: the engine never forwarded the finger. A line with `touch
down: no surface` after it: the compositor did not know the window.

## Suspend and resume

Close the lid, then open it.

- No `the machine is awake` line: `PrepareForSleep` never arrived and
  `DrmSleep` is not subscribed.
- `the machine is awake` with no `configuring N display(s)` after it: the
  relight ran and the modeset did not.
- The desktop shows unlocked on waking: look for `this desktop is locked; the
  machine can sleep` before the sleep.

## Console switch

Press `Ctrl+Alt+F<n>`, wait 20 s, and switch back. Expect:

- the other console at once, with no stale frame;
- `configuring N display(s)` on the way back;
- no `Crashing GPU process` line;
- keys and the pointer working again.

## Pointer theme

On a tty, set `theme.cursor_theme` to an installed theme with a distinct arrow
(`"Bibata-Modern-Amber-Right"`) and `theme.cursor_size = 64`. Expect:

- `the desk's pointer theme is "Bibata-Modern-Amber-Right" at 64 px`, then
  `loaded <n> cursors from "Bibata-Modern-Amber-Right"`, and that arrow on
  screen without moving the pointer.
- The same over a native window and in a text field (an I-beam from the
  theme).
- After removing both keys, the line `the desk names no pointer theme` and
  Chromium's arrow again.
- `no cursor theme "<theme>" on the XCursor path`: the theme is not under any
  directory [SHELL-CONFIG.md](SHELL-CONFIG.md#theme) lists.

## Pointer hiding

On a tty, set `theme.cursor_hide_after_ms = 1000` and
`theme.cursor_hide_when_typing = true`. Expect:

- `the desk hides the pointer after 1000 ms and while typing`.
- The pointer gone from the screen (the CRTC cursor plane) 1 s after the last
  move, and back on the next move or two-finger scroll.
- Typing a letter hides it; Shift alone and `Ctrl+C` do not.
- Hover kept while hidden: a link under the pointer stays underlined, and a
  tooltip stays open.

If it shows when it should not, or stops hiding, run with
`--log-level=0 --vmodule=*pointer_hiding*=1` (`domicile-launch` runs the engine
at `--log-level=2`, which drops them). Each hide logs `hiding the pointer`. A hide
the cursor client did not apply logs `kept the pointer shown`. Each input that
brings the pointer back logs its event name, device and flags. A held button
that blocks hiding logs `no pause while buttons ... are held`.

## Pointer lock in a game

Run a game or VM viewer that locks the pointer: a first-person game under
Wayland (for example with SDL's `SDL_VIDEODRIVER=wayland`), or a VM viewer
such as GNOME Boxes after clicking into the guest. Expect:

- The pointer disappears and the camera or guest mouse follows the mouse
  without stopping at the window's or the screen's edge.
- Switching windows with a keyboard chord brings the pointer back, and the
  game stops turning.
- Coming back to the window locks it again.

With the compositor at `--log-level debug`, a lock logs `pointer constraint
offered -> Host` then `pointer constrained`, and letting go logs `pointer let
go`.

## Pointer confinement and raw mouse motion in a game

On a console, with a physical mouse. Run a game or VM viewer that confines
the pointer rather than locking it, such as a strategy game under Wayland
(SDL's `SDL_VIDEODRIVER=wayland` with mouse grab on) or `virt-viewer` with its
pointer grab. Put its window across two monitors if it fits. Expect:

- Pushing the mouse against each edge of the window stops the pointer there,
  on both monitors, and it slides along the edge.
- Switching windows with a keyboard chord frees the pointer; coming back
  holds it again.
- In a game that reads raw motion (aiming in a first-person game with
  pointer lock), a fast and a slow flick over the same distance on the desk
  turn the camera the same amount, as with acceleration off.

## Dead GPU process

```sh
pkill -f 'chrome.*--type=gpu-process'
```

Expect the screen back within seconds and no `logind refused` line.

## Dead compositor

```sh
pkill domicile-compositor
```

Start a desktop with a browser window and a client open first. Expect:

1. `the compositor exited (signal: 15 (SIGTERM))`
2. `starting the compositor again in 1s — that is failure 1 of 5 in a row.`
3. From the engine: `the compositor on <socket> hung up; waiting 30s for the
   next one.`
4. The shell never goes away, and the browser window keeps its page. The
   client's tab closes.

A client the shell launched starts again, with a fresh window. One started from
a terminal does not come back.

## Dead engine with windows open

Start a desktop with two clients: one that keeps drawing, and one idle (a
terminal nobody types in). Then:

```sh
pkill -f 'chrome.*--domicile-broker-socket'
```

Expect, in order:

1. `the engine exited`
2. `starting the engine again in 1s — that is failure 1 of 5 in a row.`
3. One new engine, and no second `domicile is up`.
4. From the compositor: `the engine this desktop was drawing through has been
   replaced; rejoining it`
5. `rejoined the engine and restated this desktop to it shown=2 blank=0`, at
   debug (`RUST_LOG=warn,domicile_compositor=debug`)

Pass: both windows still show what they showed, including the idle one. The
idle client does not redraw, so it shows only if the compositor restored its
last frame.

Fail: `blank=` above zero, or an `on the page with nothing in it` line.

Elsewhere, `packages/e2e-harness/tests/test-a-desktop-that-fails-says-why.sh` covers the
launcher against fake components, and unit tests cover the compositor's
decisions. Only this run covers the real `dlopen`, reconnect and re-import.

## Float dragged across monitors

With two monitors and a floating terminal on the left, Meta+drag it right
until its middle passes the edge.

- Expect it drawn over both monitors while it crosses.
- Expect it to land on the right monitor and keep following the pointer until
  release.
- If it stops at the edge, the page stopped getting pointer moves when the
  pointer crossed CRTCs. See
  [ONE-PAGE-FOR-THE-DESK.md](architecture/ONE-PAGE-FOR-THE-DESK.md#input).

## Monitors at different densities

Passes in daily use on lyra with `home-office-right-two` (2026-10-25).

With a less dense monitor beside the host (`home-office-right-two`), resize a
window on it, then drag a float across onto it.

- Expect no flash of solid color on that monitor. A region may go soft for a
  frame, then sharp.
- Expect no `tile memory limits exceeded` in the engine log.
- With `--show-composited-layer-borders`, expect tiles about one monitor wide
  or narrower, never a row across the desk.
- See [DISPLAY-TILINGS.md](architecture/DISPLAY-TILINGS.md#tile-memory).

## Idle blanking

Set `idle.blank_after_seconds = 60`, leave the machine for a minute, then
touch the trackpad. Expect:

- `nobody is at this desktop; its screens go dark connectors=N`, and the
  panels off.
- `somebody is at this desktop again; its screens come back on`, then
  `configuring N display(s)`.

Then plug in a monitor while the screens are dark. It must come up dark too.

## Display manager session

Import `nixosModules.default` and set:

- `programs.domicile.enable`
- `services.displayManager.defaultSession = "domicile"`
- a `shell` in the config

The login screen should offer `domicile` and boot into that shell on the drm
platform. CI only checks that this evaluates.

## PAM lock

Import `nixosModules.default` and set `programs.domicile.enable` and
`idle.lock_after_seconds = 60`. Leave the machine until it locks.

- Your password gives `the passphrase opened this desktop`.
- A wrong password gives `a passphrase this desktop did not take` a couple of
  seconds later (`pam_unix`'s delay).
- Clients keep drawing throughout.

Tests cover real libpam through `pam_exec` with a script as the password
check. Only this run covers `pam_unix`, a real password and its setuid helper.

## Latency on a panel

From a console login, in a checkout:

```sh
nix build .#engine
nix develop .#full --command cargo build -p domicile-compositor
ENGINE="$(readlink -f result)"
nix develop .#full --command env OUT=. PLATFORM=drm \
  ./packages/domicile-engine/scripts/guard-latency.sh "$ENGINE"
```

- The verdict line compares `commit to pixel` with the probe's floor plus
  the `display frame` viz reports.
- `answered too late` above zero means fewer rounds were measured than
  planned.
- `OUT=.` because `nix build .#engine` produces a store path that is itself
  the out directory.
- Call `guard-latency.sh` directly. `packages/domicile-engine/scripts/check-latency.sh` wraps it
  in `under-wayland.sh` and takes `crux`'s render-node lock, which a laptop
  does not need.

## Several monitors

`two-monitors-on-a-tty` in `flake.nix` checks the bars, wallpapers, focus,
`mod+2` and `exec` items below on two QEMU heads, started cold. Hotplug,
different refresh rates and MST hubs still need real monitors.

Passes in daily use on lyra through a dock (2026-10-25).

Plug in one monitor, then a second. Expect:

- `configuring N display(s)` for each.
- A bar and a wallpaper on every panel.
- `told the chrome about N display(s)`.

Then check:

- `mod+2` moves keyboard focus to the monitor showing workspace 2 and leaves the
  workspace in place.
- A key bound to `exec` opens its window on the monitor with keyboard focus.
- Moving the pointer to another monitor moves keyboard focus with it.
- Windows keep drawing through all of the above.

With no profile, and with two monitors at different refresh rates, start cold.
Both panels should draw with no resize or reload, and the log should show
`presenting the desk on display`.

Also plug three identical monitors into one MST hub, together and one at a
time. Each should light with one window and no crash. This tests two
behaviors not yet seen on real monitors: a connector no layout names is placed
after the named ones, and a window belongs to its display while its page
loads.

## A profile's mode and refresh rate

Needs a monitor that offers more than one rate, such as a 120 Hz laptop panel
or a 144 Hz desk monitor. List its modes with `domicile` running: the log's
`DRM reports` line at `--v=1` shows the native one, and `wayland-info` shows
the current `wl_output` mode.

1. Add a profile entry with `"refresh": 60` and reload. The panel should
   flicker once and come back at 60 Hz: `wayland-info` shows `refresh: 60…`
   and the shell's `domicile.displays.list` has `refreshMhz` near 60000.
2. Change it to a smaller `mode` the monitor offers, such as
   `[1920, 1080]`, with no `refresh`. The panel should light at that size at
   its fastest rate, and windows should lay out across the smaller desktop.
3. Change it to a `mode` the monitor does not offer. The desktop should stay
   as it was and the log should list the sizes it offers.
4. Remove `mode` and `refresh`. The panel should go back to its native mode.

## Adaptive sync on a VRR panel

Needs a FreeSync or G-Sync Compatible monitor with adaptive sync turned on in
its own menu, on DisplayPort or HDMI 2.1, and a driver that supports it
(amdgpu, i915 or xe).

1. With no `adaptive_sync` in the profile, the shell's
   `domicile.displays.list` should say `adaptiveSync: "off"` for that monitor,
   and `"unsupported"` for a monitor without VRR.
2. Add `"adaptive_sync": true` to its profile entry and reload. The panel
   should flicker once and come back, and `adaptiveSync` should read `"on"`.
   The monitor's own OSD (often a FreeSync or refresh counter) should show the
   rate moving with what is drawn, for example while a video plays at 24 fps.
   With it on, the overview and workspace slides should be as smooth as with
   it off.
3. If it reads `"off"` instead, the log at `--v=1` should say the DRM thread
   refused a modeset with adaptive sync and tried again without it, and the
   panel should still be lit.
4. Remove `adaptive_sync` and reload. It should read `"off"` again.

## 10-bit scanout

Needs a monitor whose EDID reports 10 bits a channel (`edid-decode` on
`/sys/class/drm/card*-<connector>/edid` says "Bits per primary color channel:
10"), on DisplayPort or HDMI straight from the GPU, not through a DisplayLink
dock.

1. At `--v=1`, the GPU process should not log `cannot set 'max bpc'` for that
   connector, and `/sys/kernel/debug/dri/0/<connector>/output_bpc` (amdgpu)
   should read 10.
2. Open a smooth gray gradient page (for example a full-screen CSS
   `linear-gradient(black, white)`). It should show no bands.
3. A monitor that reports 8 bits should look as before.

## HDR on an HDR10 monitor

Needs a monitor that takes HDR10 (`edid-decode` on its EDID lists "HDR Static
Metadata Data Block" with "SMPTE ST2084"), that passes the 10-bit scanout check
above, with HDR allowed in the monitor's own menu.

1. With no `hdr` in the profile, the monitor should look as before.
2. Add `"hdr": true` to its profile entry and reload. The monitor should
   flicker once and its OSD should say it is in HDR. Windows and the shell
   should look about as bright and as colored as before, not washed out or
   oversaturated.
3. Play an HDR video in a browser tab (for example an HDR test clip on
   YouTube): its highlights should be brighter than the page's white.
4. Set `"sdr_white": 300` and reload: windows should get brighter, and the
   HDR video's highlights should not.
5. Remove `hdr` and reload. The monitor should leave HDR and look as in 1.

## A cursor an app draws itself

Needs an app that sets its own cursor image, such as GIMP with a brush tool,
a game, or `virt-viewer` over a guest. One monitor should be rotated
(`"transform": "rotate-90"` in its profile).

1. Hover the app on the upright monitor. Its own cursor should show, not the
   arrow, and it should click at its tip (paint a dot: it lands under the
   point that clicks).
2. Move the app to the rotated monitor and hover it. The cursor should stay
   upright to you and click at the same point.
3. Take a screenshot, or share the screen in a browser call, with the cursor
   over the app. The capture should show the app's cursor.
4. Type in the app with pointer hiding on. The cursor should hide and come
   back at the next move.

## Monitor cast on a GPU

`guard-display-capture.sh` runs software-composited, so it reads shared
memory. A dmabuf capture needs a GPU and a monitor.

```sh
DOMICILE_CAST_MONITOR=<output> domicile …
pw-link domicile-cast:capture_1 <consumer>:input_1
```

- `DOMICILE_CAST_MONITOR cast … Ready`, then frames in the consumer: the
  capture runs.
- `a captured frame could not be kept`: the dmabuf did not import into the
  compositor's renderer.
- `DOMICILE_CAST_MONITOR=<x>,<y>,<width>x<height>` across two monitors at
  different densities: the stream is at the higher one, with no seam.

## `dev-shell.sh` against a real engine

Run `packages/dev-shell/bin/dev-shell.sh <name>` and check:

- A saved edit shows on screen.
- Windows stay where they were.
- A shell that fails to load leaves the current shell running.

`packages/dev-shell/tests/test-dev-shell.sh` covers the watch loop, coalescing and refusal
against a fake `domicile`.

## A USB device for a page

Needs a WebHID device, such as a Ledger wallet, plugged in, and
`hardware.ledger.enable` (or the device's udev rules) on the host. Ask for it
from a page, such as a wallet extension's "connect Ledger".

- No `asked for a device; asking the shell` line: the request never reached
  patch 0110's override.
- The chooser says `No devices found`: the device is unplugged, or
  the page's filters exclude it.
- `answered with 1 device(s)` and the page cannot open the device: the session
  cannot open its `/dev/hidraw*` node. Check `getfacl /dev/hidraw*`.

## A tty desktop in a virtio-gpu VM

QEMU/KVM with virtio-gpu, on a VT. Run with
`--vmodule=gbm_wrapper=1,drm_framebuffer=4`.

- With virgl the GPU composites. On 2D virtio-gpu the launcher prints `no card
  here has 3D, so the engine composites on the CPU`, and the desktop and a
  `wl_shm` client (`foot`) draw
  ([Software output](architecture/A-DESKTOP-ON-A-TTY.md#software-output)).
- The desktop draws: the primary plane got a scanout buffer.
- `Not scanning out a … buffer … without GBM_BO_USE_SCANOUT`: it did not.
  The lines above it say why
  ([A primary plane display cannot read](TTY-DEBUGGING.md#a-primary-plane-display-cannot-read)).
- With two heads (`max_outputs=2`) and a `usb-tablet` per head, bind each by
  `phys` in `input.pointers`
  ([Tablets and touchscreens](DISPLAYS.md#tablets-and-touchscreens)). A click
  in either head's window lands under the host's cursor on that head. Hover,
  the right and middle buttons and the wheel work there as a mouse's.

## Night light on a still screen

Unverified. On a tty, leave a monitor showing something that does not move
(no clock, no blinking caret), then change the night light from the shell.
Expect the monitor to warm at once, not when the pointer next moves over it or
something on it next redraws.

## Night light and the pointer on a DisplayLink dock

Unverified. On a tty with the night light on, move the pointer from a laptop
panel onto a monitor on a DisplayLink dock. Expect a white arrow warmed the
same on both, not blue on the dock's; and the dock's pointer to warm and cool
with the night light's fade.

## An input method in a native window

Unverified. On a tty, start fcitx5 with its Wayland input method frontend and
a pinyin input method, open foot, and type `nihao`. Expect the pinyin to show
underlined in foot as you type, and Chinese text once you pick it with Space.

## An input method in a page and the shell

Unverified. With fcitx5 set up as in the check above, open a site in a
browser window, click a search box and type `nihao`. Expect the pinyin
underlined in the box as you type, and Chinese text once you pick it with
Space. The candidate list does not show over a page yet, so Space takes the
first. Do the same in the launcher. Then switch fcitx5 off with its hotkey and
type: expect plain letters, with no lag. Lock the desk and type the password:
expect it to unlock.

## Input method candidates under the caret

Unverified. With fcitx5 set up as in the check above, set a monitor to scale
1.5 and rotate it a quarter turn. Open foot on it and type `nihao`. Expect
fcitx5's candidate list just under the text cursor, crisp, and moving along
with the cursor as you type. Type on the last line of a maximized foot: expect
the list above the cursor instead. Then click another window: expect the list
to go.
