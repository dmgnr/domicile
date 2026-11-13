# Guards and spikes

End-to-end checks in `scripts/`. Each guard runs a real engine and exits
non-zero on failure. Most have a control run: the same run with one thing
changed, where the result must differ. If a guard checks that something does
not happen, its control makes it happen, which proves the guard can detect it.

A headless guard's compositor stand-in (`*-compositor.py`,
`guard-webview-keyboard-socket.py`) says nothing until the browser's `hello`,
like the real compositor. `/packages/domicile-engine/tests/test-the-guard-stand-ins-wait-for-hello.sh`
checks this.

Every guard and spike starts Chrome with `--disable-component-update`.
Otherwise Chrome downloads components into `$TMPDIR`, and a guard stops it
before the download finishes, leaving 85-195M per run in the runner's tmpfs
`/tmp`. `/packages/domicile-engine/tests/test-the-guards-disable-component-updates.sh` checks this.

A guard's page module exports `HostShell` rather than `Shell`: DomicileShell
hands `HostShell` the `DomicileHost` itself, where it hands `Shell` the SDK
layer's `Domicile` over it. The guards test the host; the layer is the SDK's
to test. `guard-shell-handover.js` and `guard-app-module-app/app.js` are the
exceptions, and check that the layer is what a shell and an app get.

CI runs them through `run-checks.sh`, which lists each one. Run one by hand
inside the toolchain shell ([BUILD-MACHINE.md](BUILD-MACHINE.md#toolchain-shell)).

## Helpers

| Script | Role |
|---|---|
| `under-wayland.sh` | runs another script under a nested wlroots compositor on the GPU, the only setup that can import a dmabuf |
| `guard_webview_devtools.py` | sends keys and clicks to a running engine over the debugging port |
| `guard-shell-pdf-viewer.py` | asks Chrome's PDF viewer frame, over the debugging port, whether it started |
| `guard-webview-guest-page.py` | the guest page for the keyboard and click guards |
| `lib-annotate.sh` | reports where a guard stopped as a GitHub annotation |
| `lib-last-words.sh` | prints the end of an engine's log, reaching back to a crash's fatal line |
| `lib-latency.sh` | reads a latency run's log; also used by `/packages/domicile-engine/tests/test-latency-report.sh` |
| `lib-compositor-cleanup.sh` | stops a nested compositor and its whole process group |
| `lib-control-budget.sh` | sizes a control's timeout from how long its guard took |
| `lib-ports.sh` | gives each guard free ports, since two engine jobs share `crux` |
| `lib-broker.sh` | gives each engine launch its own broker socket, so a dying browser that listens again cannot take the next launch's producer |
| `lib-profile.sh` | removes a guard's profile at exit, retrying while the engine's children still write into it |

## Compositing

Under `under-wayland.sh` unless marked headless.

| Guard | Checks |
|---|---|
| `guard-client-window.sh` | a Wayland client's window appears on the page in the color it drew; `SOFTWARE=1` with the engine on the CPU and the window in shared memory (`run-checks.sh guard-client-window-in-memory`); `HEADLESS=1` that path on ozone headless, with no host compositor, as a headless desktop runs (`run-checks.sh guard-client-window-in-memory-on-headless`) |
| `guard-two-windows.sh` | two clients' windows on one page, in one aggregation |
| `guard-buffer-transform.sh` | a `wl_shm` buffer drawn with `wl_surface.set_buffer_transform` is shown upright |
| `guard-scrolling-bubble.sh` | each frame of a monitor cast shows a sync bubble at the content its window scrolls, on a page that syncs frames. Control: the page places each move a step late, and the bubble is off its content |
| `guard-app-survives-load-shell.sh` | a client's frames still reach the page after `load_shell`, when the new shell's `<app>` is a different size |
| `guard-app-survives-compositor-restart.sh` | after a compositor restart under the same engine, the shell hears its window close and its watch end, watches again, hears `compositorreplaced`, and its kept `<app>` shows the next compositor's window |
| `guard-shell.sh` | a real shell, built with vite and the SDK, showing a client's window on a desktop `domicile` started |
| `guard-shell-handover.sh` | the engine calls `Shell` with the body and a working desktop, and no `navigator.domicile` or `window.domicile` exists (patch 0094); the page draws no frame while a slow module loads, and draws once `Shell` returns (patch 0127) |
| `guard-css-and-resize.sh` | CSS parity of `<app>` against `<div>`, with and without `backdrop-filter`, plus resize and latency. Headless; `GPU=1` uses the GPU |
| `guard-latency.sh` | keystroke to pixel with a real client, from the compositor's `latency` lines |
| `guard-app-only-in-shell.sh` | `<app>`, `HTMLAppElement` and `canvas.embedExternalSurface()` exist in the shell and not in a site in its `<webview>`. Headless |
| `guard-app-module.sh` | `run_app` runs an app module: its `main` gets the layer's `AppDomicile` (no `windows`) and its `files.write` reaches the compositor after `app_hello`; it `fetch()`es its own file and not the shell's (patch 0126). Control: the app's address in an unpinned window runs nothing. Headless |
| `guard-app-routes-input.sh` | `<app>` sends the pointer, wheel and keys to its client through its whole CSS transform, with no page script; a `<div>` control gets nothing |
| `guard-native-chrome-gestures.py` | optional native Google Chrome `--app` acceptance through the engine: pinch zoom without shell zoom, cancellation on element removal, recovery, two-finger history and vertical scrolling. Requires explicit Chrome/compositor paths; see [TESTING.md](TESTING.md#native-chrome-gestures) |
| `guard-windows-state.sh` | `windows`, `focusedWindow` and the appearance attributes follow the compositor, every event name fires, and every CSS cursor keyword reaches the page; and that a system call and its answer cross the browser. Headless |
| `guard-portal-requests.sh` | a shell that listens late for `portalrequests` hears them; `answerPortalRequest` reaches the compositor and a malformed answer does not. Headless |
| `guard-desk-state.sh` | the desk's state attributes (idle, lock, themes, clipboard, tray with each icon's bus, menu and `itemIsMenu`, modifiers) say what the compositor said, to a shell that reads without listening; the pointer theme on `appearance` reaches the browser process. Headless |
| `guard-held-moments.sh` | a `focusrequested` sent before the shell listens reaches its first listener, once. Headless |
| `guard-asks-promise.sh` | `searchFiles()` resolves with its answer, and a newer search rejects the older with an `AbortError`. Headless |
| `guard-shortcut-chords.sh` | a chord grabbed by name is resolved against the compositor's keyboard, taken from the page and released by name, and given back once every grab is ungrabbed; a bad or untypable chord throws. Headless |
| `guard-desktop-geometry.sh` | the engine reports desktop size and density to the compositor without the page's help, and the page has the whole window (patch 0095). Headless |
| `guard-shortcuts-inhibitor.sh` | a nested engine sends `inhibit_shortcuts` to the host (patch 0038) |
| `guard-shortcuts-inhibitor-chord.sh` | sway honors it: `Mod4+y` reaches the page, not sway. Needs a reachable sway |

Results: [ENGINE-FORK-MEASUREMENTS.md](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md).

## Shell page

Headless.

| Guard | Checks |
|---|---|
| `guard-shell-shortcuts.sh` | Chrome's reload, back, fullscreen, zoom, close and quit keys do nothing to the shell (patch 0047) |
| `guard-shell-local-network.sh` | the shell loads an image from loopback with no Local Network Access prompt (patch 0066) |
| `guard-shell-web-apis.sh` | the shell may show notifications and read cross-origin responses (patches 0066, 0105) |
| `guard-notification-server-late.sh` | the browser connects to a notification server that takes its name after the browser looked, on a private bus (patch 0134) |
| `guard-notification-window.sh` | a page's notification names its browser window in `x-domicile-browser-window`, and the shell's names none, on a private bus with a stand-in server (patch 0172) |
| `guard-shell-script-src.sh` | an injected inline `<script>` and `onerror` do not run in the shell; a `<script src>` from the shell root does |
| `guard-domicile-fetch.sh` | the shell `fetch()`es a file beside it and one from `domicile://home/` (patch 0126); a site in its `<webview>` reads neither with `fetch()`, a no-cors `fetch()` or `XMLHttpRequest` |
| `guard-shell-pdf.sh` | Chrome's PDF viewer starts on a PDF from `domicile://home/` in the shell's `<iframe>`, as the launcher's preview shows one (patch 0154) |
| `guard-video-codecs.sh` | the engine plays H.264 and AAC (`src/build/args/domicile_codecs.gn`); VP9 is the control |
| `guard-browser-brand.sh` | sites are told the engine is Google Chrome in `navigator.userAgentData` and `Sec-CH-UA` (patch 0157); `Chromium` is the control |
| `guard-display-capture.sh` | a display capture through the C ABI reads back the shell's color, before and after a resize |
| `guard-headless-desk.sh` | with `--domicile-headless-desk`, two virtual displays come on `virtual-1` and `virtual-2`, and a capture of each shows its own slice of the one shell page; a click and the A key sent with `domicile_input_inject` reach the shell |
| `guard-shell-crash.sh` | a crashed shell ends the engine with a FATAL line saying the shell's renderer died and that this is a bug in Domicile (patch 0124) |

## Browser windows (`<webview>`)

Headless.

| Guard | Checks |
|---|---|
| `guard-webview-framing.sh` | a site that refuses framing still shows |
| `guard-webview-notifications.sh` | a page must ask before it notifies, even in a profile that stores an allow-all default (patch 0105) |
| `guard-webview-history.sh` | back, forward, reload and stop; the element's navigation state, load progress, address and connection security |
| `guard-webview-history-new-window.sh` | `goBackInNewWindow()` opens a window one step back through a copy of the view's history, and the view stays put |
| `guard-webview-untrusted-cert.sh` | an https page with a self-signed certificate reads `security` `dangerous`; the same certificate trusted reads `secure` |
| `guard-webview-find.sh` | find in page, including a cross-site frame; find next starts from the active match (patch 0073) |
| `guard-webview-keyboard.sh` | a desktop shortcut pressed in a guest is caught; an unclaimed Ctrl+R goes to the shell as `domicile-guest-keydown` |
| `guard-webview-escape.sh` | Escape with an unfocused browser window does not crash the browser (patch 0037) |
| `guard-webview-browser-page.sh` | `chrome://history` in a browser window is refused by `BrowserPageThrottle` (patch 0083) |
| `guard-webview-click.sh` | a click in a browser window fires an event in the shell's document |
| `guard-webview-activate.sh` | a page brought to the front (`Page.bringToFront`, the same `Activate()` as a notification click's `client.focus()`) fires `domicile-focus-request` |
| `guard-webview-routed-link.sh` | a middle click on a link opens a browser window through `OpenURLFromTab` |
| `guard-webview-target-url.sh` | the link under the pointer reaches the shell as `targetUrl`, clears when the pointer leaves the page, and returns when it comes back |
| `guard-webview-tooltip.sh` | a `title` in a frame from another site reaches the shell as the `<webview>`'s tooltip at the pointer, in the element's coordinates (patch 0181), after Chrome's delay |
| `guard-webview-device-request.sh` | a page's `navigator.hid.requestDevice()` from a press asks the shell as `domicile-device-request`, and the shell's cancel reaches the page as no devices |
| `guard-webview-dialog.sh` | a page's `prompt()` from a press asks the shell as `domicile-dialog`, and the shell's text reaches the page as `prompt()`'s value |
| `guard-webview-external-app.sh` | a press on a page's `domicile-guard:` link asks the shell as `domicile-external-app` with the link, the site and `mayRemember`, in place of Chrome's dialog (patch 0176), and the shell's answer reaches the browser |
| `guard-webview-sign-in.sh` | a page behind a sign-in (HTTP authentication) asks the shell as `domicile-sign-in` with the site, the realm, `proxy` and `secure`, in place of Chrome's dialog (patch 0177), and the shell's user name and password sign the page in |
| `guard-webview-file-access.sh` | a page that opened a file and writes to it asks the shell as `domicile-prompt` (`file-edit`, with the site, the name and the path) in place of Chrome's prompt (patch 0179), and the shell's yes lets the page write it; its control says no and the file is kept |
| `guard-webview-page-failure.sh` | a page that fails to load (an empty HTTP 500, then no answer at all) is reported to the shell as `domicile-page-failure-change` (`http` with its status, then `network` with `ERR_EMPTY_RESPONSE`) in place of Chrome's error pages (patch 0180), and the page that loads after clears it; its control loads a page that works and reports nothing |
| `guard-webview-resend-form.sh` | reloading a page a form posted to asks the shell as `domicile-prompt` (`resend-form`, with the site and the page's title) in place of Chrome's "Confirm Form Resubmission" dialog (patch 0181), and the shell's yes posts the form again; its control says no and the form is posted once |
| `guard-webview-page-picker.sh` | pressing a color input asks the shell as `domicile-picker` (`color`, with the value, the page's suggested color and the input's box) in place of Chrome's picker (patch 0182), and the color the shell picks reaches the page; its control cancels and the page keeps black |
| `guard-webview-chrome-sheets.sh` | a page in a `<webview>` has no `PaymentRequest` and no `IdentityCredential` (FedCM), each of which asks with a Chrome sheet (patch 0183, `RefuseChromeDialogs`); its control is the same page seeing `navigator.credentials` and document picture-in-picture |
| `guard-webview-video-picture-in-picture.sh` | a video a page puts in picture-in-picture is listed to the shell for its window, in place of Chrome's floating window (patch 0210); the shell shows it in an `<app picture-in-picture>`, and its close pauses the video and takes it off the list; its control is the video playing before the request |
| `guard-webview-print.sh` | a browser window's `print()`, then its page's own `window.print()`, each start and finish a print through the system dialog, with no Print Preview |
| `guard-webview-beforeunload.sh` | `closeBrowserWindow` on a page whose `beforeunload` asks to stay asks the shell as a `beforeunload` dialog; Cancel keeps the window and Leave closes it |
| `guard-webview-fullscreen.sh` | a page enters fullscreen from its own button, the shell hears it as `pageFullscreen`, and Escape (typed on a swapped Caps Lock) and `exitPageFullscreen()` each take it out |
| `guard-webview-wake-lock.sh` | a page's `navigator.wakeLock` turns the shell's `wakeLock` on, and its release turns it off (patch 0158) |
| `guard-webview-context-menu.sh` | a right click fires `domicile-context-menu` with the link and image under it; its `inspect` opens DevTools in a browser window (patch 0092); a right click in DevTools draws its HTML menu; closing the inspected window closes DevTools' too, and the engine survives it |
| `guard-webview-new-window.sh` | a `target="_blank"` form opens a browser window, the shell's `<webview window>` shows it, and its page gets the form's POST |
| `guard-webview-window-open.sh` | a page's `window.open()` returns a handle, the window is listed at the size it asked for, keeps its opener and name, and posts back to its opener (patch 0115) |
| `guard-webview-private.sh` | a cookie set in a `<webview private>` reaches private pages and windows, never ordinary ones; a private window is listed `isPrivate`; the cookie is gone once every private page closes |
| `guard-webview-partition.sh` | storage in a `<webview partition>` is apart from the user's and from other partitions; a window from `openBrowserWindow(url, partition)` is listed and stored in its partition; `persist:` outlives a restart and any other name does not |
| `guard-webview-will-navigate.sh` | a page's own navigation asks the shell as `domicile-will-navigate`; `preventDefault()` keeps it from being requested (patch 0134); the shell's own `src` does not ask |
| `guard-webview-app-window.sh` | an app window (`open_url` with `"app":true`) is listed `isApp` and records no visits; an ordinary window opened after it is recorded; the shell's `openAppWindow` opens a window listed `isApp` |
| `guard-app-window-reuse.sh` | an app window with an id is reused by `"reuse":"focus"` and `"navigate"` (`open_url`, and the shell's `openAppWindow`) instead of opened again, and asks to be in front; `navigate` loads the address in it; `countBrowserWindowMatches` counts in a drawn window |
| `guard-webview-survives-load-shell.sh` | a browser window's page keeps running across `load_shell`, and the new shell's `<webview window>` shows it |
| `guard-webview-hidden.sh` | a browser window's page is hidden while its `<webview>` is `display: none`, visible once shown, and hidden again after; once shown it never blinks `hidden` (patch 0162) |
| `guard-webview-moved.sh` | a browser window's page is attached again and visible after its `<webview>` moves in the shell's document, as React's `insertBefore` does |
| `guard-webview-paused.sh` | a window whose page is paused on a `confirm()` slides and shrinks at the frame rate of one whose page runs (patch 0155) |
| `guard-animation-main-frames.sh` | a composited transform slide runs without a main frame for each of its frames: the field trial testing config has no `CompositedAnimationsForceMainFrames` study (patch 0196); `NEGATIVE=1` forces them and must see one a frame |
| `guard-webview-crash.sh` | a page whose renderer crashes sets `renderProcessGone` to `crashed`, its view draws nothing over the shell, and `reload()` brings it back (patch 0124) |
| `guard-webview-permissions.sh` | a page's `getUserMedia` asks the shell over `domicile-permission-request`; the shell's allow reaches the page and is stored for the site (patch 0103) |
| `guard-webview-media-devices.sh` | a `<webview>` lists the fake cameras, and `setMediaDevice` puts the chosen one first, the camera a page that names none gets (patch 0117) |
| `guard-webview-count-matches.sh` | a `<webview>`'s `countMatches` counts a selector in its page's document, not the shell's, and throws a `SyntaxError` for a bad selector |
| `guard-webview-upload.sh` | `<input type="file">` asks the shell over `domicile-file-chooser`, and the page reads the chosen file (patch 0053) |
| `guard-webview-download.sh` | a download asks the shell, lands at the chosen path (patch 0053), and is listed on the desk in progress, then as finished, with its path, until the shell removes it |
| `guard-webview-save-picker.sh` | `showSaveFilePicker()` asks the shell (patch 0086) |
| `guard-webview-passkey-extension.sh` | WebAuthn requests reach an extension on `chrome.webAuthenticationProxy` (patches 0048, 0069, 0084) |

## Extensions

Headless.

| Guard | Checks |
|---|---|
| `guard-webview-content-script.sh` | a `--load-extension` content script runs in a `<webview>` |
| `guard-extension-installer.sh` | an extension named in the compositor's `extensions` message is installed (patch 0055) |
| `guard-extension-in-private.sh` | an extension the `extensions` message's `settings` allow in private windows runs in a `<webview private>`; without them it does not |
| `guard-extension-tray.sh` | the tray event, popup, its auto-resized size and `window.close()` (patch 0056) |
| `guard-extension-open-popup.sh` | `action.openPopup()` reaches the shell as `extensionpopuprequested` |
| `guard-extension-side-panel.sh` | `sidePanel.open()` opens the side panel's page as a popup window with no size, which the shell tiles |
| `guard-webview-tabs.sh` | `tabs.query` and `tabs.setZoom` target the focused `<webview>` (patch 0057), and `webNavigation.getAllFrames` lists its page |
| `guard-webview-active-tab.sh` | a tray click grants `activeTab` to the focused tab |
| `guard-webview-popup-window.sh` | `windows.create({type: "popup"})` opens a browser window the shell draws at the requested size |

## Spikes

Standalone checks of `<app>` embedding. Run by hand unless noted.

| Script | Does |
|---|---|
| `spike.sh` | runs one spike step; the producer's exit code is the result. `guard-css-and-resize.sh` calls it |
| `spike-page.html`, `spike-css-page.html`, `spike-resize-page.html` | the pages for `spike.sh` and the CSS run, served from `domicile://shell/`, the only origin with `<app>` |
| `spike-engine.sh` | drives `libdomicile_engine.so` from a C process |
| `spike-dmabuf.sh` | imports, submits and releases a real dmabuf; under `under-wayland.sh` |
| `spike-iframe.sh` | compares `<app>` with an out-of-process `<iframe>`. Does not run: its page is an http page, which has no `<app>` |
