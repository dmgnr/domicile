# @domicile-desktop/engine

## 0.4.0

### Minor Changes

- d0fbc5b: Turn your monitors off on demand with `domicile sleep-displays`, and back on with any key, click or pointer move, or `domicile wake-displays`. Your windows and workspaces stay where they were. Shells get the same through `displays.sleep()` and `displays.wake()`.
- d566f68: A cursor an app draws itself, such as a game's, an image editor's brush or a VM viewer's, now shows in place of the arrow. The compositor sends each image the app commits as a PNG on `app_cursor`, and `DomicileWindow.cursorImage` gives it to the shell as a CSS `cursor` value. Manganese sets it on the window's element.
- 87ac040: The compositor serves `xdg-system-bell-v1`, so a terminal's bell reaches the shell. `domicile.windows.bells()` streams each ring with the `appId` of the window that rang.
- 24b88fb: Dragging the title bar or edge an app draws itself, such as a GNOME app's header bar or Firefox's tab strip, moves or resizes its window. The compositor checks the press is still held, takes it from the app, and reports `WindowRequest.Move` or `WindowRequest.Resize` (with a `ResizeEdge`); Manganese runs the drag as it does a Meta drag.
- 81215c5: A shell can name any window to a capture tool. Each window's `toplevelId` and each browser window's `toplevelId` is its identifier on `ext-foreign-toplevel-list-v1`, so a shell can hand it to a tool such as `grim -T` instead of matching by title. The compositor sends a native window's on `app_appeared` and the browser windows' on `browser_toplevel_ids`.
- 9b20adc: Capture tools that pick a window from the toplevel list, such as `grim` and
  `wf-recorder` through `ext-image-capture-source-v1`, now see browser windows
  too, and capture a browser window's page alone.
- 3e37020: A client asking to be minimized now reaches the shell as `WindowRequest.Minimize`. The shell can also set `WindowState.Resizing` on a window while it resizes it, and the client sees `resizing` in its configure.
- 2a1913f: A display profile can set a monitor's mode and refresh rate. `mode: [W, H]` now lights the monitor at that size, refusing the profile when the monitor does not offer it, and the new `refresh` (in Hz) picks the nearest rate the monitor offers. The SDK's `Display` gains `refreshMhz`, the rate the monitor scans out at.
- dd0fb71: Games and VM viewers can read how far the mouse moved (`zwp_relative_pointer_v1`), to turn a camera or drive a guest's mouse. A shell's pointer warp sends no relative motion. Locking and confining the pointer come next.
- da632d6: A shell can give you a way back from a VM or remote desktop viewer that holds your shortcuts. A chord bound `--inhibited Meta+Escape` stays the shell's while that window has the keyboard, and `keyboard.switchShortcutsInhibitor` turns the window's hold off and on. Manganese has a `shortcuts-inhibitor toggle` command to bind to it.
- a5ade39: Games and VM viewers can lock the pointer (`zwp_pointer_constraints_v1`). The compositor offers the lock to the shell for the window under the pointer as `pointerConstraint`, and tells the client only once the shell holds a pointer lock on the window's `<app>` and reports it with `windows.pointerConstrained()`. The engine grants a shell's pointer lock with no click first and no browser bubble. Manganese locks for the focused window and lets go when the keyboard moves away. Confining the pointer to a window is offered but not taken yet.
- b9c14d1: Pages and the shell now compose text from an input method such as fcitx5 or
  IBus, as native windows do. Its candidate list does not show over them yet.
- 8c477cc: Name a monitor to turn only that one off, like `domicile sleep-displays DP-1`. It keeps its windows and workspace, and stays off while you use the others until `domicile wake-displays DP-1`. Shells pass the name to `displays.sleep()` and `displays.wake()`.
- 996cc29: A shell can hear when nobody has been at the desk for a time it chooses (`session.idleAfter`), or a time before the screens blank (`session.idleBeforeBlanking`). These replace `session.idleWarnings` and the `idle.warn_before_seconds` setting, which are gone.
- 8ff882e: Extensions can run in private windows. Each extension's chrome://extensions settings are now yours to set: whether it runs in private windows and on local files, whether it may run user scripts, and which sites it runs on (when you click it, on specific sites, or on all sites). Set them in the config's `extensions.settings`, by extension id, or in the Settings app, which shows the ones an extension can use while it is on and moves Options and Uninstall to the bottom of its row. A setting the config drops goes back to Chrome's default.
- 25522ef: Set how held keys repeat with `input.keyboard.repeat` (`delay_ms`, `rate`; 0 turns repeat off). Native windows and pages follow it, and a reload applies it without resending the keymap. The default is 500 ms and 25 a second.
- e821d1f: A display profile can turn on adaptive sync (variable refresh rate, FreeSync, G-Sync Compatible) per monitor with `adaptive_sync: true`. It is off by default, asked for only where the monitor and driver report support, and retried without it when the driver refuses the modeset. The SDK's `Display` gains `adaptiveSync` (`unsupported`, `off` or `on`), which says what the hardware is doing. Settings now reads profiles that set `refresh` or `adaptive_sync` instead of refusing them.
- 19cc2c5: Tapping Super on its own opens and closes the overview, as it does on GNOME and KDE. Holding Super for a shortcut, a drag or a scroll still works as before. Shells can bind a tap of any modifier alone by writing just its name, such as `Meta` or `Alt`, in their keybindings.

### Patch Changes

- bce2815: Pinching a PDF no longer magnifies its rendered image, which pixelated its text. Only the PDF viewer zooms it.
- 274e12d: Night light and other color ramps set right after startup or a monitor change now stick, instead of being dropped until the next modeset.
- f658eb3: Each frame tells a DisplayLink dock only the part of the screen that changed, so its driver should use less CPU.
- 6642166: A desktop running a checked engine, as `main` does between an engine change and the next nightly build, says so in a notification and points you to stable or a release.
- 70c8440: A window holding a shortcuts inhibitor, such as a VM or a remote desktop viewer, now gets the three- and four-finger swipes and holds the shell binds, as it already gets the shell's key chords.
- d59061f: The engine is built on Chromium 160, with its fixes and web platform updates.
- ead2330: A monitor whose page flip never finishes, as a DisplayLink dock's can, no longer freezes the whole desktop.
- 0bf960f: A night light or gamma change now shows on a monitor at once, even when nothing on it is redrawing.

## 0.3.0

### Minor Changes

- c664ef4: Shells bind touchscreen swipes in from a screen's edge, written `edge:left`, `edge:right`, `edge:top`, `edge:bottom` or `edge`, beside their keys and touchpad gestures. A finger landing at an edge the shell binds waits until it is clearly coming in; a scroll or tap there still reaches the app underneath. Manganese swipes between a monitor's workspaces from its side edges.
- 1af639c: File access, client certificate, Bluetooth pairing and extension permission prompts now ask in the shell, over the page, instead of in Chrome's unstyled dialogs drawn over the desktop. Sites in browser windows can now be allowed to edit files they open. `<webview>` fires `domicile-prompt`.
- eba7d0d: Night-light apps such as gammastep and wl-gammarelay-rs work: Domicile speaks `wlr-gamma-control`, so each can warm, dim or curve each monitor on its own. While an app holds a monitor, the shell's night light leaves it alone, and takes it back when the app lets go. `displays.setColorTemperature(kelvin, display)` warms one monitor by name.
- af7415e: Hide the pointer while typing and after a pause in pointer input, with `theme.cursor_hide_when_typing` and `theme.cursor_hide_after_ms`. The next pointer move, click, scroll or touchpad gesture shows it again.
- bb1e4cb: A page's tooltips, the "send the form again?" question on reload and the "page isn't responding" question are now the shell's, instead of Chrome's. `<webview>` reports its tooltip as `tooltip` with `domicile-tooltip-change`, and `domicile-prompt` gains the `resend-form` and `unresponsive` kinds. Reloading a page a form posted to used to do nothing; it now asks.
- 63db244: Chrome never draws a dialog over the desktop. Any Chrome dialog the shell has no answer for is canceled and logged, so a gap fails closed. Payment Request and FedCM ("Sign in with Google"'s account chooser) are off, so sites use their own checkout and sign-in pages, and picture-in-picture video is off since Chrome floats it in a window of its own. Document picture-in-picture still opens, as a shell window.
- d3bf90b: Touchpad swipes and holds of three or more fingers that the shell doesn't bind now reach the app under the pointer, so apps that use them work: in Manganese, which binds three- and four-finger swipes, holds and five-finger swipes go to the app.
- f592184: Shells bind touchpad gestures of three fingers or more beside their keys, in sway's `bindgesture` grammar such as `swipe:3:left`, and in the same modes. `DomicileHost.grabGesture()` and the `gesture` event carry every phase; `domicile.gestures` wraps them. Manganese swipes four fingers between a monitor's workspaces, and gains `workspace next_on_output` and `prev_on_output`.
- 18413ff: A link for an app, such as Zoom or Slack, asks "Open Zoom?" over its page in the shell's style, naming the app and showing its icon, instead of Chrome's unstyled "Open xdg-open?" dialog. A secure site can be let open these links without asking. Shells get `domicile-external-app` on `<webview>`.
- 69fe0d8: A page that can't load, has a certificate problem, is flagged as unsafe or crashes now shows a shell page with Try again, Go back or Continue anyway, instead of Chrome's own error and warning pages. `<webview>` reports why as `pageFailure` with `domicile-page-failure-change`, and `proceedPastWarning()` passes a warning.
- a354497: A site or proxy that asks for a username and password now asks in the shell, over the page, instead of in Chrome's unstyled dialog drawn over the desktop. `<webview>` fires `domicile-sign-in`.
- 71a8c7b: Keep a web page gliding after a two-finger flick, as native apps already do. The glide follows your fingers' own speed, so scroll acceleration doesn't make it overshoot. Resting or moving your fingers on the touchpad stops it.
- 9246b97: A page's color, date and time pickers and a text box's suggestion list are now drawn by the shell, hung from the control, instead of by Chrome. `<webview>` fires `domicile-picker` with the control's kind, value, suggestions and box, answered with `choose()` or `cancel()`.
- 411a31d: A finger on a native window reaches it as a touchscreen touch, so apps scroll, select and pinch as they do on any Wayland desktop. An app that reads no touch gets the first finger as the pointer and its left button. A finger on a window no longer pans or zooms the shell around it. A touchscreen with no `input.pointers` entry now covers the only display when there is one, so a laptop's own touchscreen works with no config.
- b8ccdba: Forward touchpad pinch gestures to native Wayland clients, including Google Chrome page zoom. Preserve the platform gesture phases, absolute scale, rotation and cancellation through the engine and `<app>`.

### Patch Changes

- 952d3ee: Fix web pages not gliding after a two-finger flick, and slow two-finger scrolls going missing soon after a flick.
- 7e3f354: Shells can use WebAssembly, so a shell can be written in Rust or another language that compiles to wasm. `examples/dioxus-shell` is one, in Dioxus.
- bc4a277: A closing window animates out with its contents again, instead of its picture vanishing at once. The compositor keeps a closed app window's surface, and the engine a closed browser window's page (muted), for a second while the shell animates it out.
- 2ec7ecc: A page's tooltips now wait Chrome's delay before showing, and a tooltip in a frame from another site (Bitwarden's autofill menu, a Cloudflare challenge) shows at the pointer instead of far from it.
- 9a150aa: Brings back the browser engine's speedups that the previous release turned off by mistake, while keeping workspace slides from redrawing the desktop on every frame.
- 9f763cf: Pinch works as on a Mac. A two-finger pinch magnifies the browser page under the pointer without reflowing it, and a native app gets its own pinch. Meta+pinch or Meta+two-finger scroll magnifies the whole screen around the pointer. A plain pinch over the shell does nothing.
- 56275da: A touchpad pinch works with several monitors. With the pointer on any monitor but the one hosting the desk, a pinch did nothing, with or without Meta.
- 16f8ff4: App windows no longer flash white while they resize. An app may throw away a frame the screen is still showing, such as one drawn at its old size. The engine now keeps that frame until the screen is done with it, instead of drawing a blank in its place.
- a542f66: On a console, the pointer keeps the desk's cursor theme when it comes back from hiding over a window that names no cursor, instead of switching to Chromium's own arrow.
- 9554847: A pointer hidden by typing stays hidden when the shell moves it to follow keyboard focus, such as on switching windows, opening one or closing the focused one. Only a hand on the mouse or touchpad shows it again.
- a006e48: The GPU process no longer runs without its seccomp filter, at random, when a thread it joined just before its sandbox started is still listed in `/proc`.
- d69b2f4: A page's notification names its browser window, so only the Gmail inbox's own window has its duplicate notifications cleared; Gmail in another window notifies again.
- f14ec1c: A tty desktop whose graphics card cannot draw, even on the CPU, no longer restarts its GPU process forever on a black screen. Chromium's GPU crash limit is back on, and when no GPU mode works `domicile` stops with "renderer unavailable" and exit code 69.
- 4b5b6f7: On a tty, a website's own pointer image (such as the hand over a Google map) turns with a rotated monitor instead of showing on its side.
- e8696d9: `domicile load-shell` goes back to the shell you had when the new one fails to run, and prints why.
- cdb3534: Stop touchpad flicks in native apps from scrolling far past where you aimed. Native apps get libinput's scroll distance and run their own momentum; scroll acceleration now applies to pages only.

## 0.2.1

### Patch Changes

- 0eedcd6: On a tty, Mesa can open the card inside the GPU sandbox, and VMware cards are off Chromium's GPU blocklist, so a VMware guest with 3D on composites on the GPU instead of the CPU.

## 0.2.0

### Minor Changes

- fdad979: Middle-clicking Back or Forward in a browser window's address bar opens that step in a new window, as Chrome does in a new tab. The new window keeps the page's history, and the window you clicked in stays where it was.
  
  `<webview>` gains `goBackInNewWindow()` and `goForwardInNewWindow()`.

### Patch Changes

- 8d8417d: App windows show when the engine's GPU process falls back to software, as in some VMs: the compositor sends them in memory instead of leaving them transparent.

## 0.1.0

### Minor Changes

- fe90bca: App windows can belong to an app id, and a launch can reuse that app's open window instead of opening another: `domicile open --app --id <id> --reuse focus|navigate <url>`, or `browser.openApp(url, { id, reuse })`. Windows list their `appId`. `browser.countMatches(id, selector)` counts elements in a browser window's page, hidden or not.
- 66d220b: Show a browser window's zoom and finished downloads in popups that hang from the address bar, as Chrome does. The downloads popup lists each file with Open, Show in folder and Remove from list, and the Downloaded indicator opens it again. `<webview>` gains `downloadCompletedPaths` and `removeCompletedDownload()`; `Popover` gains `anchor` and `quiet`; `ListRow` gains `endOnHover`.
- d3a65c5: Clipboard history rows say whether a copy is an image: `DomicileClipboardEntry.image` is true for an image with no text, and manganese's clipboard history draws those rows with an image glyph.
- eca2588: Clipboard history rows show a thumbnail of a copied image: `DomicileClipboardEntry.thumbnail` is a small PNG `data:` URL (empty for none; the SDK gives `undefined`), and `RowTile` takes a `picture` to draw in place of its glyph.
- 9fe15f8: Downloads from every window, browser and app alike, now show in one Downloads item on the bar, shown while there are any. It says how far the downloads in progress have come, and its panel lists each download with where it came from, to cancel, open, show in its folder, or remove. The address bar's downloads chip and the downloads popup over the page are gone.
  
  The engine keeps one list of the desk's downloads, so a download outlives its window. The SDK reads it as `domicile.downloads` (`list`, `cancel`, `remove`, `clear`, and a `change` event); `<webview>`'s per-page download properties, `clearCompletedDownloads`, `removeCompletedDownload` and `downloadschange` are removed.
- f3156a1: Emulated input (remote desktop, input sharing) on a desktop on a TTY now reaches the shell and the lock screen, as on a headless desktop. A headless desktop's monitors draw at their own scale, and emulated pointers land where they point on a scaled or rotated monitor.
- 40f5af3: The engine casts the desktop to Google Cast TVs: `domicile.googleCast` lists them, and casts to them and stops. `engineCast(domicile.googleCast)` in `@domicile-desktop/sdk/cast` is its backend, and the `Cast` bar item uses it, so it shows when a TV is near.
- ab2d2f0: The engine hands `Shell` the typed `Domicile` and an app's `main` the `AppDomicile`, built by the SDK's layer, which the engine bundles. Shells and apps no longer call `desktop()`/`appDesktop()`. The SDK drops `system()`, the portal watch helpers and `./appearance` from its public API; use the `Domicile` namespaces.
- 5955f66: On a headless desktop, input from a remote desktop app (EIS) reaches the shell and its lock screen, so the desktop can be driven and unlocked with no keyboard or mouse attached. Screen casts of a headless desktop now show the pointer.
- 401b0b4: `OZONE=headless` runs a full desktop with no display device or seat, such as on WSL2. Its monitors are virtual ones the shell adds, and screen casts show each one. Apps draw in shared memory, GL apps included.
- fccc784: Automatic brightness and a night light, as on macOS. The backlight follows the room's light from iio-sensor-proxy and learns from the levels the user sets. The night light warms every monitor from sunset to sunrise in the time zone's city, or on custom hours, with a switch in the brightness popover. Both are on by default and set in the Settings app's Shell page or under `shell_options`. Shells set the color temperature with `domicile.displays.setColorTemperature(kelvin)`.
- ca86667: A shell can add a monitor with no connector, which the desk extends onto and only a capture shows, with `system(domicile).addVirtualMonitor()`. Casting to a TV extends the desk this way.

### Patch Changes

- 494a3f0: Reading pixels back from a page's canvas no longer waits for the screen to refresh on a tty, so pages that read many canvases no longer freeze.
- c7af3d5: Each Google Cast asks the shell what to show, so Extend and Cast… work after an earlier cast; before, the engine silently recast its first pick. A cast to a TV of another shape is letterboxed in black, not green.
- b8bdff3: Casting or recording a rotated monitor shows the pointer upright, as it looks on the monitor, instead of turned with the panel.
- 06cf6dd: The homepage FAQ names the Chromium version and revision the engine is built on, read from the engine's pin, and says how a newer Chromium reaches you. `CHROMIUM_VERSION` holds the pin's version, and a check keeps the two in step.
- f23af29: Show the shell's pointer shapes (grab hand, resize arrows, link hand) on every monitor, not only the one hosting the desk page.
- da62acc: `distro/` and `distro-checks` merge into `packages/distro`. Files every distribution installs (session, launchers, portal, systemd targets, D-Bus service) move from `nix/` to `share/`; `nix/` keeps only the Nix modules.
- 17064a7: A browser window whose `<webview>` moves in the shell's document shows its page again where it lands. Before, the page stayed detached and the window froze, which happened when a window crossed monitors while being resized.
- a88ce23: The engine is a workspace package: its shell tests run in `test:shell`, and its checks against a built tree in `test:engine`.
- ecd3fba: An extension's `action.openPopup()` opens its popup in the tray, so Phantom's tray button opens Phantom. The SDK reports the request as `extensions.on("popup")`.
- 0e8c788: Extension popups size themselves as in Chrome: Blink's auto-resize, between 25x25 and 800x600. Phantom no longer grows wider on every layout, and Solflare gets its full 402x600. The tray shows a popup once its page has loaded, so it no longer opens narrow and then jumps. `contentWidth` and `contentHeight` report only for an `extensionpopup` view. `Popover` takes `withheld`, to lay a panel out before showing it.
- 62a671f: An extension's `sidePanel.open()` opens its side panel as a tiled window of its own, with no address bar, so Phantom, which opens in its side panel by default from 26.37, opens again. A popup an extension asks for opens under the icon that was clicked, on that monitor, not on the focused one; the tray state gains `clicked`.
- 7b48b3b: A page in a browser window is told the monitor it is on as its `screen`, not the box around every monitor. A fullscreen video that sizes itself to the screen is letterboxed instead of cropped.
- 901b871: The keystroke latency run divides by the display frame viz reports, not an assumed 60 Hz, and also reports `commit to present` from viz's presentation feedback. Its guard allows `commit to pixel` the probe's floor plus one frame, so a 120 Hz panel passes.
- b85d9bb: Name what keeps the screens on. A new `idle_holds` system call (`session.idleHolds()` in the SDK) lists the windows and applications holding idle inhibitors, and the bar's eye opens and names them. The compositor logs each change, and the input that restarts the idle clock when it was getting close to blanking or locking, naming the event and device for the browser's own input.
- 1931e3e: The night light warms an AMD laptop's screen as soon as it turns on, not only after the screen next blanks.
- 86d2d09: A native window growing under the pointer no longer flashes white at its new edges.
- b1041f8: The last package-specific scripts leave `scripts/`: `dev-shell` becomes a package the shells' `start:dev` runs, docs media capture moves into the site, `update-engine-release.sh` and the IDL check into the engine, and `smoke-compositor.sh` into the e2e harness.
- 8e980fa: Sites are told the browser is Google Chrome, in `navigator.userAgentData` and `Sec-CH-UA`. Akamai's bot check refused Chromium's brands on some sign-ins, such as Citi's.
- c55d65e: A native tooltip (an `<img title>`) on a desk with several monitors opens beside the pointer, on that monitor.
- fe9f571: A browser window's page no longer reads `hidden` for a moment when its window is shown or attached, so pages that refetch or animate on `visibilitychange` stay still.
