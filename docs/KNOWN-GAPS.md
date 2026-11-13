# Known gaps

What Domicile doesn't do yet, or does with a catch. Each links to the doc with
the detail, when there is one. Remove a gap when it's fixed.

## Windows and clients

- **No built-in Xwayland.** X11-only apps run through xwayland-satellite,
  which you start yourself: [X11 apps](/docs/use/COMPATIBILITY.md#x11-apps).
  Electron, SDL and Qt apps are started in Wayland mode (`client_command` in
  `spawning.rs`).
- **Clients only get 8-bit formats, and output is 8-bit SDR.**
  [COLOR.md](/docs/architecture/COLOR.md#plan).
- **Games can't confine the pointer to their window yet.** A lock works:
  manganese locks the pointer for the focused window under it. A confinement
  is offered to the shell (`pointerConstraint: "confine"`), but no shell takes
  it, because the engine has no way yet to keep its pointer inside a box on a
  desk of several monitors. A confinement's region is not read either; a lock
  or confinement covers the whole window.
- **Relative motion's unaccelerated deltas are the accelerated ones.** The
  engine forwards the page's `movementX/Y`, which is after pointer
  acceleration (`crate::relative_pointer`).
- **A chrome repaint damages the whole output.**
- **Windows under a fullscreen window keep drawing,** so manganese can animate
  the fullscreen window back to its box.
- **Browser window context menus have only Chrome's core items.** No spelling
  suggestions, page or extension items.
- **An input method's candidate list does not show over pages or the
  shell:** they compose from it, but only native windows show its list.
  [TEXT-INPUT.md](/docs/architecture/TEXT-INPUT.md#plan).
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
- **The night light can't warm a DisplayLink monitor.** Its driver (`evdi`)
  has no gamma table.

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
- **No payments or "Sign in with" account sheets.** Chrome draws these
  itself, so they are turned off until the shell has its own.
  [ENGINE-BROWSER-BEHAVIOR.md](/docs/architecture/ENGINE-BROWSER-BEHAVIOR.md#chromes-dialogs-sheets-and-floating-windows).
- **Resize cost is unmeasured.**
  [ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md#embed-deadlines).

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
