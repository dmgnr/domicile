# Known gaps

What Domicile doesn't do yet, or does with a catch. Each links to the doc with
the detail, when there is one. Remove a gap when it's fixed.

## Windows and clients

- **No built-in Xwayland.** X11-only apps run through xwayland-satellite,
  which you start yourself: [X11 apps](/docs/use/COMPATIBILITY.md#x11-apps).
  Electron, SDL and Qt apps are started in Wayland mode (`client_command` in
  `spawning.rs`).
- **A display in SDR tells clients it is sRGB with gamma 2.2,** whatever its
  panel's gamut, because that is how the engine draws it.
  [COLOR.md](/docs/architecture/COLOR.md).
- **Nested or headless, a confinement does not hold the pointer.** The
  client is told it is confined, but only the console's cursor is held in the
  window (`DomicileHost.confinePointer`); a host compositor or the headless
  desk moves its own. Unaccelerated relative motion there is the accelerated
  motion, since only libinput on a console reports both.
- **A chrome repaint damages the whole output.**
- **Windows under a fullscreen window keep drawing,** so manganese can animate
  the fullscreen window back to its box.
- **Browser window context menus have only Chrome's core items.** No page or
  extension items.
- **An input method's candidate list does not show over pages or the
  shell:** they compose from it, but only native windows show its list.
  [TEXT-INPUT.md](/docs/architecture/TEXT-INPUT.md#plan).
- **A `wl_shm` window in 10-bit or half-float stays blank after the engine
  falls back to software:** the engine shows only 8-bit frames from memory.
  [A-DESKTOP-ON-A-TTY.md](/docs/architecture/A-DESKTOP-ON-A-TTY.md#software-output).
- **Unknown: whether viz hit testing must agree with Domicile's.**
  [ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md#open-questions).

## Displays

- **Presentation is unmeasured.** Every measurement reads a
  `CopyOutputRequest`; nothing reads a lit CRTC. So overlay promotion
  (including that viz declines it under `backdrop-filter`), damage and
  presentation latency are unmeasured. Revisit if real hardware shows a
  performance problem. [ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md#plan).
- **The desk rasters what no monitor shows.**
  [DISPLAY-TILINGS.md](/docs/architecture/DISPLAY-TILINGS.md#cost).

## Browser windows

- **The shortcuts inhibitor (patch `0038`) is tested only on sway,** and
  only with a virtual keyboard. mutter may show an unseen permission dialog.
  [ENGINE-FORK-MEASUREMENTS.md](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md#host-shortcut-inhibitor).
- **Some permission requests are refused,** such as storage access, an
  extension's `chrome.tabCapture`, and keyboard and pointer lock prompts.
- **No `chrome://` pages,** so no Print Preview: printing goes straight to
  the desktop's print dialog.
- **Some extension calls are refused.**
  [EXTENSIONS.md](/docs/architecture/EXTENSIONS.md).
- **A browser window attached while hidden is visible for a moment,** so the
  page sees `visibilitychange` twice (`WebViewGuest::AttachWindowTo`).
- **No payments.** Chrome draws the payment sheet itself, so it is turned off
  until the shell has its own.
  [ENGINE-BROWSER-BEHAVIOR.md](/docs/architecture/ENGINE-BROWSER-BEHAVIOR.md#chromes-dialogs-sheets-and-floating-windows).
- **A page's app link can't open a `Terminal=true` app,** such as a
  terminal mail client for `mailto:`: the engine has no `DOMICILE_TERMINAL`,
  so its `domicile open` skips them (`let_the_engine_open_links`).
- **Resize cost is unmeasured.**
  [ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md#embed-deadlines).

## Drag and drop

- **Drags don't cross between pages and native windows,** in either
  direction: the desk runs its own drags, and the compositor's
  `wl_data_device` drags stay among native windows.
  [A-DESKTOP-ON-A-TTY.md](/docs/architecture/A-DESKTOP-ON-A-TTY.md#drag-and-drop).

## Clipboard

- **A nested desktop's browser uses the host's clipboard.**

## Session and portals

- **The session portal setup is only checked at evaluation.** Nothing here
  runs a user manager, an unclean exit leaves stale environment variables,
  and a nested desktop doesn't register.

## Shell reload

- **Hot-swapping the shell reloads the page,** so a shell loses state kept in
  its page.

## Engine CI

- **Engine CI is one machine.** `crux` runs one cold build at a time, and a
  build from scratch takes 4h 16m.
  [BUILD-MACHINE.md](/packages/domicile-engine/docs/BUILD-MACHINE.md#build-cost).
- **A guard's engine once crashed in fontconfig.** A use-after-free in the
  browser process's font service (`FontDataServiceImpl::MatchFamilyName` →
  `FcConfigSubstituteWithPat` → `FcStrHashIgnoreCase`), seen once in
  `guard-webview-tabs`. Not the shared font cache. Rerun it; an ASan engine
  build would find what freed the string.
