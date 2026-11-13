# domicile

## 1.3.0

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
- 1f229ad: An input method's candidate list now shows just under the text cursor in
  native windows, moves with the cursor as you type, and goes above it near the
  bottom of the screen.
- dd0fb71: Games and VM viewers can read how far the mouse moved (`zwp_relative_pointer_v1`), to turn a camera or drive a guest's mouse. A shell's pointer warp sends no relative motion. Locking and confining the pointer come next.
- da632d6: A shell can give you a way back from a VM or remote desktop viewer that holds your shortcuts. A chord bound `--inhibited Meta+Escape` stays the shell's while that window has the keyboard, and `keyboard.switchShortcutsInhibitor` turns the window's hold off and on. Manganese has a `shortcuts-inhibitor toggle` command to bind to it.
- a5ade39: Games and VM viewers can lock the pointer (`zwp_pointer_constraints_v1`). The compositor offers the lock to the shell for the window under the pointer as `pointerConstraint`, and tells the client only once the shell holds a pointer lock on the window's `<app>` and reports it with `windows.pointerConstrained()`. The engine grants a shell's pointer lock with no click first and no browser bubble. Manganese locks for the focused window and lets go when the keyboard moves away. Confining the pointer to a window is offered but not taken yet.
- b9c14d1: Pages and the shell now compose text from an input method such as fcitx5 or
  IBus, as native windows do. Its candidate list does not show over them yet.
- 8c477cc: Name a monitor to turn only that one off, like `domicile sleep-displays DP-1`. It keeps its windows and workspace, and stays off while you use the others until `domicile wake-displays DP-1`. Shells pass the name to `displays.sleep()` and `displays.wake()`.
- 996cc29: A shell can hear when nobody has been at the desk for a time it chooses (`session.idleAfter`), or a time before the screens blank (`session.idleBeforeBlanking`). These replace `session.idleWarnings` and the `idle.warn_before_seconds` setting, which are gone.
- 947e5d3: Input methods such as fcitx5 and IBus now compose text in native windows:
  preedit shows inline as you type, and the text you pick is committed. On-screen
  keyboards and other tools that type through `virtual-keyboard-v1` work too. The
  candidate list is not shown yet, and pages and the shell do not compose from an
  input method yet.
- 9bd54ab: The config can name a terminal with `terminal`, such as `["kitty"]`. When it does, applications that run in a terminal, such as htop and vim, show up in the launcher and under "Open with", and `domicile open` runs them in it. Meta+Return opens it in Manganese. Without one, nothing changes: Domicile still has no default terminal.
- 8ff882e: Extensions can run in private windows. Each extension's chrome://extensions settings are now yours to set: whether it runs in private windows and on local files, whether it may run user scripts, and which sites it runs on (when you click it, on specific sites, or on all sites). Set them in the config's `extensions.settings`, by extension id, or in the Settings app, which shows the ones an extension can use while it is on and moves Options and Uninstall to the bottom of its row. A setting the config drops goes back to Chrome's default.
- 25522ef: Set how held keys repeat with `input.keyboard.repeat` (`delay_ms`, `rate`; 0 turns repeat off). Native windows and pages follow it, and a reload applies it without resending the keymap. The default is 500 ms and 25 a second.
- e821d1f: A display profile can turn on adaptive sync (variable refresh rate, FreeSync, G-Sync Compatible) per monitor with `adaptive_sync: true`. It is off by default, asked for only where the monitor and driver report support, and retried without it when the driver refuses the modeset. The SDK's `Display` gains `adaptiveSync` (`unsupported`, `off` or `on`), which says what the hardware is doing. Settings now reads profiles that set `refresh` or `adaptive_sync` instead of refusing them.
- 19cc2c5: Tapping Super on its own opens and closes the overview, as it does on GNOME and KDE. Holding Super for a shortcut, a drag or a scroll still works as before. Shells can bind a tap of any modifier alone by writing just its name, such as `Meta` or `Alt`, in their keybindings.

### Patch Changes

- bce2815: Pinching a PDF no longer magnifies its rendered image, which pixelated its text. Only the PDF viewer zooms it.
- ed5a83e: Fix memory filling up until the desktop crashes when every app draws with the GPU. The compositor now lets go of a window's old graphics buffers once the app frees them.
- 274e12d: Night light and other color ramps set right after startup or a monitor change now stick, instead of being dropped until the next modeset.
- f658eb3: Each frame tells a DisplayLink dock only the part of the screen that changed, so its driver should use less CPU.
- d6d5370: When the desktop falls back to drawing without the graphics card, Domicile now says so in a notification with a "Report it" button, and logs an error.
- 6642166: A desktop running a checked engine, as `main` does between an engine change and the next nightly build, says so in a notification and points you to stable or a release.
- 70c8440: A window holding a shortcuts inhibitor, such as a VM or a remote desktop viewer, now gets the three- and four-finger swipes and holds the shell binds, as it already gets the shell's key chords.
- d59061f: The engine is built on Chromium 160, with its fixes and web platform updates.
- ead2330: A monitor whose page flip never finishes, as a DisplayLink dock's can, no longer freezes the whole desktop.
- fdc9064: Locking the desktop ends an application's held global shortcut, such as push-to-talk, instead of leaving it active until the next press.
- 4be0576: Firefox takes the mouse. A subsurface whose input region leaves the pointer out, as Firefox's content surface's does, passes it to its window.
- 0bf960f: A night light or gamma change now shows on a monitor at once, even when nothing on it is redrawing.
- d91a8a6: Menus from native apps now enter only the displays their window is on and draw at that display's scale, rather than at the densest scale on every display. They follow their window when it moves to another display.
- Updated dependencies [9f22031]
- Updated dependencies [24b88fb]
- Updated dependencies [eaa92c7]
- Updated dependencies [1209f22]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [0ee4ce8]
- Updated dependencies [996cc29]
- Updated dependencies [8ff882e]
- Updated dependencies [e821d1f]
- Updated dependencies [4b7a878]
- Updated dependencies [9ea68bf]
- Updated dependencies [5090cbd]
  - @domicile-desktop/shell-simple@0.0.5
  - @domicile-desktop/manganese@1.3.0
  - @domicile-desktop/app-settings@0.2.0
  - @domicile-desktop/app-history@0.0.5
  - @domicile-desktop/shell-splash@0.0.5
  - @domicile-desktop/builder@0.1.3

## 1.2.0

### Minor Changes

- c664ef4: Shells bind touchscreen swipes in from a screen's edge, written `edge:left`, `edge:right`, `edge:top`, `edge:bottom` or `edge`, beside their keys and touchpad gestures. A finger landing at an edge the shell binds waits until it is clearly coming in; a scroll or tap there still reaches the app underneath. Manganese swipes between a monitor's workspaces from its side edges.
- 1af639c: File access, client certificate, Bluetooth pairing and extension permission prompts now ask in the shell, over the page, instead of in Chrome's unstyled dialogs drawn over the desktop. Sites in browser windows can now be allowed to edit files they open. `<webview>` fires `domicile-prompt`.
- eba7d0d: Night-light apps such as gammastep and wl-gammarelay-rs work: Domicile speaks `wlr-gamma-control`, so each can warm, dim or curve each monitor on its own. While an app holds a monitor, the shell's night light leaves it alone, and takes it back when the app lets go. `displays.setColorTemperature(kelvin, display)` warms one monitor by name.
- af7415e: Hide the pointer while typing and after a pause in pointer input, with `theme.cursor_hide_when_typing` and `theme.cursor_hide_after_ms`. The next pointer move, click, scroll or touchpad gesture shows it again.
- bb1e4cb: A page's tooltips, the "send the form again?" question on reload and the "page isn't responding" question are now the shell's, instead of Chrome's. `<webview>` reports its tooltip as `tooltip` with `domicile-tooltip-change`, and `domicile-prompt` gains the `resend-form` and `unresponsive` kinds. Reloading a page a form posted to used to do nothing; it now asks.
- 8eaae53: Configure touchpad tapping, clicking, scrolling and typing suppression, and mouse acceleration and scrolling, through the desktop config. Choose native libinput typing suppression or configurable pauses. Apply settings on reload and device reconnection.
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
- 8c2c52e: Fix WebGPU getting no adapter on NixOS: the Vulkan loader beside the engine is now nixpkgs' NixOS-aware one.
- 56275da: A touchpad pinch works with several monitors. With the pointer on any monitor but the one hosting the desk, a pinch did nothing, with or without Meta.
- 16f8ff4: App windows no longer flash white while they resize. An app may throw away a frame the screen is still showing, such as one drawn at its old size. The engine now keeps that frame until the screen is done with it, instead of drawing a blank in its place.
- a542f66: On a console, the pointer keeps the desk's cursor theme when it comes back from hiding over a window that names no cursor, instead of switching to Chromium's own arrow.
- 9554847: A pointer hidden by typing stays hidden when the shell moves it to follow keyboard focus, such as on switching windows, opening one or closing the focused one. Only a hand on the mouse or touchpad shows it again.
- a006e48: The GPU process no longer runs without its seccomp filter, at random, when a thread it joined just before its sandbox started is still listed in `/proc`.
- d69b2f4: A page's notification names its browser window, so only the Gmail inbox's own window has its duplicate notifications cleared; Gmail in another window notifies again.
- f14ec1c: A tty desktop whose graphics card cannot draw, even on the CPU, no longer restarts its GPU process forever on a black screen. Chromium's GPU crash limit is back on, and when no GPU mode works `domicile` stops with "renderer unavailable" and exit code 69.
- d83d2d9: Closing kitty, or another app that frees its last frame before it closes, animates with its contents again, in a tab group too. The compositor keeps a frame still on screen until it is replaced or the window's close animation ends.
- c7973a8: A pinch on a window keeps going when a pinch begins for a window the pointer is not on, instead of ending.
- 7166899: Show GPU-drawn apps on NVIDIA drivers whose EGL can't list devices, by opening the GPU through GBM instead
- 27e6e33: A machine whose EGL lists no devices and whose render nodes have no GBM, such as a VM without 3D, renders in software instead of serving `wl_shm` clients only.
- 4b5b6f7: On a tty, a website's own pointer image (such as the hand over a Google map) turns with a rotated monitor instead of showing on its side.
- e8696d9: `domicile load-shell` goes back to the shell you had when the new one fails to run, and prints why.
- cdb3534: Stop touchpad flicks in native apps from scrolling far past where you aimed. Native apps get libinput's scroll distance and run their own momentum; scroll acceleration now applies to pages only.
- Updated dependencies [76c4390]
- Updated dependencies [c664ef4]
- Updated dependencies [7371c33]
- Updated dependencies [bc45b4c]
- Updated dependencies [b3e7457]
- Updated dependencies [62ccd23]
- Updated dependencies [af7415e]
- Updated dependencies [d69b2f4]
- Updated dependencies [174918e]
- Updated dependencies [e2418db]
- Updated dependencies [f592184]
- Updated dependencies [50318b4]
- Updated dependencies [56adc6f]
  - @domicile-desktop/manganese@1.2.0
  - @domicile-desktop/app-settings@0.1.2
  - @domicile-desktop/app-history@0.0.4
  - @domicile-desktop/builder@0.1.2
  - @domicile-desktop/shell-simple@0.0.4
  - @domicile-desktop/shell-splash@0.0.4

## 1.1.2

### Patch Changes

- 0d1d2dd: On a tty, a VMware guest with 3D on composites on the GPU instead of the CPU.

## 1.1.1

### Patch Changes

- 8d8417d: App windows show when the engine's GPU process falls back to software, as in some VMs: the compositor sends them in memory instead of leaving them transparent.
- c44f0f2: A desktop on a tty in VirtualBox (VMSVGA) or VMware with 3D acceleration off composites on the CPU, so app windows show instead of staying transparent.
- Updated dependencies [93e6a4b]
  - @domicile-desktop/manganese@1.1.1
  - @domicile-desktop/builder@0.1.1
  - @domicile-desktop/app-history@0.0.3
  - @domicile-desktop/app-settings@0.1.1
  - @domicile-desktop/shell-simple@0.0.3
  - @domicile-desktop/shell-splash@0.0.3

## 1.1.0

### Minor Changes

- fe90bca: App windows can belong to an app id, and a launch can reuse that app's open window instead of opening another: `domicile open --app --id <id> --reuse focus|navigate <url>`, or `browser.openApp(url, { id, reuse })`. Windows list their `appId`. `browser.countMatches(id, selector)` counts elements in a browser window's page, hidden or not.
- fff3e24: A window's screen cast carries its app's sound, and a monitor's every app's, in a PipeWire audio node beside the video.
- 64ffcb7: `domicile theme [light|dark|toggle]` switches the desktop's theme from a terminal, or prints it. It works with any shell and needs no pointer.
- eca2588: Clipboard history rows show a thumbnail of a copied image: `DomicileClipboardEntry.thumbnail` is a small PNG `data:` URL (empty for none; the SDK gives `undefined`), and `RowTile` takes a `picture` to draw in place of its glyph.
- f15f43a: The clipboard history is wider and shows more of each copy: up to four lines of text with its line breaks, and a larger image preview beside its size. What is on your clipboard gets its own group above what was copied before. The compositor previews 480 characters and makes thumbnails up to 256 px. `RowTile` drops its `picture` prop.
- 0ba4ab7: `domicile monitor <name> <W>x<H>[@Hz]` adds a virtual monitor until stdin ends, resizing it to each size read.
- e455955: `domicile open <file|folder|url>` opens anything: a web link in a browser window, anything else with its type's default from `mimeapps.list`, supertypes counted (a `text/plain` default opens Markdown and source code). `domicile open --app <url|module>` opens a site or app module as an app. Domicile's `xdg-open` and the launcher's Enter run it, so apps, terminals and the launcher agree. `open-url`, `open-app` and `run-app` are gone: use `open` and `open --app`.
- f3156a1: Emulated input (remote desktop, input sharing) on a desktop on a TTY now reaches the shell and the lock screen, as on a headless desktop. A headless desktop's monitors draw at their own scale, and emulated pointers land where they point on a scaled or rotated monitor.
- 56e1c22: File picker polish:
  
  - New folder button, and a Hidden files toggle (Ctrl+H).
  - The listing updates when the folder changes.
  - The save name box no longer walks a `/`.
  - No key help in the sidebar; full-size sidebar buttons.
  - Portal labels drop GTK's `_` access key marks ("_Save" shows as "Save").
  - `System.createDir` (`create_dir`) makes a directory. `FileRequest.list` is replaced by `FileRequest.folders` (`systemFolders` in `@domicile-desktop/component-library/folders`).
- e42226f: `theme.force_dark` names sites, such as `mail.google.com`, that the browser draws dark with Chromium's automatic dark mode while the theme is dark, for sites with no dark theme of their own.
- 5955f66: On a headless desktop, input from a remote desktop app (EIS) reaches the shell and its lock screen, so the desktop can be driven and unlocked with no keyboard or mouse attached. Screen casts of a headless desktop now show the pointer.
- 401b0b4: `OZONE=headless` runs a full desktop with no display device or seat, such as on WSL2. Its monitors are virtual ones the shell adds, and screen casts show each one. Apps draw in shared memory, GL apps included.
- a999398: The keep awake panel draws each app's own icon. `idleHolds` now hears app ids, for the shell to name and draw with `useApps`, instead of names.
- 9d4a876: The keep awake pill names the website a browser window keeps the screens on for ("Kept awake by youtube.com"), with its icon, instead of the engine. `<webview>` gains `wakeLock` and `domicile-wake-lock-change`, and the compositor lists the engine's own hold as `domicile-browser`.
- 44d0983: Switch keyboard layouts at runtime. `input.keyboard.keymaps` lists named keymaps; the first is the one the desktop starts on. The `keymap next` and `keymap <name>` commands switch every keyboard and show a toast, and the new `Keymap` bar item, in the default bar left of the theme toggle and on the lock screen, shows and switches it. The item's list and the toast show xkb's name for each layout. A switch lasts until the desktop restarts. The shell option `keymap.hideDefault` hides the item on the first keymap, and the Settings app's Keyboard page edits the list.
  
  The component library adds `ChoiceRow` (`RadioRow`, `CheckboxRow` and `ChoiceList`), the screenshot picker's rows as a component, and `ChoiceToast` takes a `detail` line.
- b2c6fd5: Cast the desktop to Miracast TVs (Fire TV, Roku, Samsung, LG, Windows wireless displays) over Wi-Fi Direct or the LAN. The new `domicile-miracast` service runs each cast; `miracastCast(domicile)` in `@domicile-desktop/sdk/miracast` is its backend, and the `Cast` bar item lists its TVs.
- 3da1465: `domicile monitor` takes an optional scale after the size, like `domicile monitor TV 3840x2160 2`, and so does each resize line on stdin.
- 93f015d: A page can ask for window management, local fonts, idle detection and automatic downloads. The shell asks the user, and Settings and the site panel show each.
- fccc784: Automatic brightness and a night light, as on macOS. The backlight follows the room's light from iio-sensor-proxy and learns from the levels the user sets. The night light warms every monitor from sunset to sunrise in the time zone's city, or on custom hours, with a switch in the brightness popover. Both are on by default and set in the Settings app's Shell page or under `shell_options`. Shells set the color temperature with `domicile.displays.setColorTemperature(kelvin)`.
- 2bf4b18: A desktop whose machine lacks the lock's PAM service, such as a `nix run` trial, does not lock: locked, nothing could unlock it. An urgent notification, "This screen won't lock", says so at startup, and the log names the file to add. Adding it turns the lock on with no restart. The Manganese page notes this under its trial command.
- cd52ce3: The launcher's "Open with…" now lists first the app Enter opens the file with, so the two always agree. `domicile open --which <file|url>` prints the app `domicile open` would run, and the desktop puts its own `domicile` first on its apps' `PATH`.
- bbf849b: A client can ask to be laid out at a named place in the shell's page (`domicile_anchor_v1`). Shells read it as `DomicileWindow.anchor`.
- 93f015d: A page's `getDisplayMedia()` reports the surface picked (window, browser window or monitor) and, when it asks for audio, gets the source's sound. A browser window is captured as a tab, with its sound, `cropTo()` and capture handle.
- 3bb9bd5: A download's file picker starts in the download folder (`XDG_DOWNLOAD_DIR`). The file chooser event has `currentFolder`.
- 52a1d65: The screenshot and screen share pickers draw a window that is not on screen, such as a tab behind another, in place of the desk when it is picked. `System.previewWindow` draws one, through the compositor's new `preview_window` system call.
- 3e5b976: The print dialog labels every option and saves to PDF: pick "Save to PDF" as the destination, then where to save it.
- 1c7e183: The desktop stays smooth while the machine is busy without joining the `domicile` group: the engine asks rtkit to raise its drawing threads when the limits refuse. The NixOS module enables rtkit, and the packages recommend it. The group is optional and gives the most reliable result.
- 2430e48: Screen recording: `domicile screen-record` and the Screen Record launcher entry pick a screen, window or region and record it with its sound to `~/Videos/Screen recordings/`, with a floating toolbar (pause, resume, stop, discard) left out of the recording.
- 9fd298a: The screen share picker offers browser windows, streaming the page alone, and previews each source on the desk. The screenshot picker shows the same preview tiles.
- 33444d9: Settings has a Site data page: each site that stores cookies or other data, its size, and a button that removes it.
- 912dcac: A desktop on a tty lights a screen with no 3D (2D virtio-gpu, Hyper-V, simpledrm, vkms): the engine composites on the CPU and windows reach it in shared memory. `DOMICILE_SOFTWARE_COMPOSITING=yes` or `no` overrides the guess.
- 6c3db42: A virtual monitor can be resized in place with `resize`, keeping its output, windows and casts.
- 9c89f16: A virtual monitor can have a scale of its own, such as 1.5, when added or resized (`addVirtualMonitor` and `resize` take `scale`).
- ca86667: A shell can add a monitor with no connector, which the desk extends onto and only a capture shows, with `system(domicile).addVirtualMonitor()`. Casting to a TV extends the desk this way.
- f50a783: Wayland capture tools (`grim`, `wf-recorder`, OBS's wlroots capture) copy from a running cast of the monitor, frame after frame, into shm or dmabuf buffers, and get only frames with damage they have not seen.
- cd5614b: Wayland capture tools can list windows (`ext-foreign-toplevel-list-v1`) and capture one alone, and follow the pointer with a cursor session.
- ee1cc17: `<webview partition="persist:name">` gives a page storage of its own, kept on disk; any other name keeps it in memory. `openBrowserWindow(url, partition)` opens a window in one, listed with its `partition`. A page's own navigation fires a cancelable `domicile-will-navigate` first.

### Patch Changes

- 58dac0a: An app module's system calls survive a compositor restart: the engine ends them with `compositor_gone` and dials the new compositor, so the SDK's watches and D-Bus matches listen again.
- dba9bdb: An idle blank turns the monitors off. The engine left every connector it was told to turn off out of the modeset, so the screens kept showing the desktop. A profile that turns a panel off turns it off too.
- c49b1d6: The screens stay off once they blank: a pointer that did not move no longer wakes them.
- 866cf8e: Video calls and films in a browser window keep the screens on. The compositor serves `org.freedesktop.ScreenSaver`, so a screen wake lock (Google Meet, YouTube) holds the desktop awake while its window is shown.
- 1dbe9e4: A browser window screen cast draws the pointer over the page.
- af3a4e8: Fix black recordings and casts of a browser window: its stream now starts at the page's size instead of one pixel.
- 8494716: On a tty, the engine takes each graphics card from logind, which hands DRM master over on a console switch, and keeps reading the keyboard and mouse while logind answers.
- 0af60e0: A screen cast draws the pointer at the screen's scale, so it is a normal-size arrow on a HiDPI screen rather than a speck.
- 623860a: While a TV is cast to, the desk holds off idle blanking and holds notification banners, which the TV could show. `inhibitIdle` takes the reason the portal is told.
- 5fc22c6: Sharing part of a hidden window from a page no longer reopens the picker: the restore token keeps the part while the compositor runs.
- 4759ab2: A fractionally scaled window's screen cast draws the pointer where it is, at its size.
- 47716fe: Screen casts drawn on the GPU show the pointer wherever it is, not only near the top left corner.
- dc2e78f: Screen casts draw the pointer that is on screen, such as a hand over a link, instead of a fixed arrow.
- 952fc0a: A TV the desktop extends onto goes above the monitors, centered, so the pointer reaches it by going up.
- 4594119: The shell no longer crashes when an animation ends just as a page with text stops being opaque: the engine waits for the frame it is about to show before redrawing that text.
- 1161efd: `domicile --help` (or `-h`, `help`, or `<verb> --help`) lists every command.
- 22844b3: Docs audit: Wayland-only app support and the apps we check, the config schema served from domicile-desktop.com, locking in a `nix run` trial, portal requests a shell must answer, a complete packaging example, GPU troubleshooting for users, a NixOS flake example, differences from Chrome, and contributor-only sections labeled in the package references.
- eda45b9: A window drawing faster than the engine can show it no longer crashes the engine's GPU process: while viz is 16 frames behind, the engine holds the window's newest frame and drops the ones it replaces.
- 17064a7: A browser window whose `<webview>` moves in the shell's document shows its page again where it lands. Before, the page stayed detached and the window froze, which happened when a window crossed monitors while being resized.
- 93f015d: A browser window's `<select>` and other popups stay on the monitor they open on, rather than opening across a seam.
- ecd3fba: An extension's `action.openPopup()` opens its popup in the tray, so Phantom's tray button opens Phantom. The SDK reports the request as `extensions.on("popup")`.
- 62a671f: An extension's `sidePanel.open()` opens its side panel as a tiled window of its own, with no address bar, so Phantom, which opens in its side panel by default from 26.37, opens again. A popup an extension asks for opens under the icon that was clicked, on that monitor, not on the focused one; the tray state gains `clicked`.
- 506b12f: Apps known only by an id that no desktop entry uses, such as `com.chromium.Chromium`, are named by a matching entry or a readable form of the id ("Chromium") in portal dialogs, the sharing indicators, global shortcut conflicts and portal notifications.
- 8ffb4c5: On a device whose render node allocates no GBM buffers, such as vgem under WSL2, the compositor allocates on the device's primary node, so shared-memory windows and casts are no longer blank there.
- 73dd960: Gmail's new-mail notifications are drawn with Gmail's site icon, the one the launcher shows, instead of a letter. A notification's picture may be an image's `data:` URL.
- 6730912: A browser window hidden behind a tab can be screenshotted, previewed and shared: the engine lists it as `isCaptured` while a capture runs, and manganese keeps it laid out under the shown tab. The screenshot and share pickers keep their size when a pick shows a preview. A shared screen's cursor reaches consumers that read it as metadata, such as Chrome.
- 2a87739: The screenshot and screen cast pickers take a part of a window that is not on screen, dragged over its preview.
- 4b76732: A hidden window, on another workspace or behind a tab, no longer keeps the screens on with its idle inhibitor. It holds them again once shown, as the protocol asks.
- b16913f: Typing or pointing in a browser window or the shell keeps the desk awake, so it no longer locks under somebody typing.
- b0e0a13: The keep-awake eye names what holds the screens on as you know it (Claude, not com.anthropic.Claude), from each application's desktop entry.
- 901b871: The keystroke latency run divides by the display frame viz reports, not an assumed 60 Hz, and also reports `commit to present` from viz's presentation feedback. Its guard allows `commit to pixel` the probe's floor plus one frame, so a 120 Hz panel passes.
- fc744c5: The launcher lists matching files shallowest first, so files near home come before ones deep in a tree.
- 1fb14ba: Launcher file search lists files and folders whose name matches before those that match only in a parent folder's name, even when the parent-folder matches are shallower.
- 4ac3c0d: The launcher previews PDFs again: the PDF viewer starts in the shell instead of drawing an empty gray pane.
- b85d9bb: Name what keeps the screens on. A new `idle_holds` system call (`session.idleHolds()` in the SDK) lists the windows and applications holding idle inhibitors, and the bar's eye opens and names them. The compositor logs each change, and the input that restarts the idle clock when it was getting close to blanking or locking, naming the event and device for the browser's own input.
- 558794b: The network item stays on the bar after a lock and when the network service fails, hiding only on a machine with no network hardware. It shows a cable that iwd or wpa_supplicant cannot report, and its panel lists each wired port with its speed, addresses and gateway. `system-network` adds `interfaces`: the hardware from `/sys/class/net` and addresses from `ip`, which the compositor's wrapper now puts on `PATH`.
- 7dc458f: The night light turns off again, on schedule and from its switch.
- 508f227: A notification that comes without an icon is drawn with its app's icon, found from its `desktop-entry` hint or its app name, instead of a letter.
- 2c10391: Pressing a notification from an app that is running with no window open, such as Slack closed to its tray, starts the app again so it shows its window.
- 3a7a001: Pressing a notification raises its app's window even when the app asks with its own activation token instead of the one the press hands it, as Slack and other apps on Electron before 42 do.
- ce4b472: Site and shell notifications reach the desktop even when the compositor's notification server starts after the engine. The engine waits up to 20 seconds for it instead of falling back to Chrome's own popups.
- 61ef2b4: An application's notifications clear once you look at it: when its window gets the keyboard, or when you press any of its notifications. Slack and most Linux applications never close their own.
- e2d8a62: Sharing from Slack asks once: an app's casts started together take the one pick, instead of putting up a picker each.
- 670713c: The app chooser asks in plain words. With one application it asks "Open Claude?" beside Claude's icon ("Chromium wants to open this link in Claude."); with several, "Choose an app to open this link"; with none, "No app can open this link" and only Close. The link shows on one muted line at the bottom. `AppChooser` takes `asker`, `opened` and `address` in place of `title` and `description`.
- 3ee3ca0: PDFs, images and videos open in a browser window of the desktop by default, as links do.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- 01c092d: A window whose page shows an `alert()`, `confirm()` or `prompt()` no longer slows a workspace switch, or a window growing or shrinking. The shell waited for the paused page to draw on every frame.
- 99ff136: Keep the default log quiet. Routine compositor lines (idle holders, display reloads, casts, thread priorities, requests refused while locked) are debug, and the launcher prints its choices and the shell build's progress only on a terminal.
- 4ad0520: Screen recordings of a screen or region are scaled down to at most 4K's pixels, so a whole desk of high-density monitors records smoothly instead of at a few frames a second.
- 8007832: Screen recordings encoded on the GPU play to the end: they use constant quality instead of a fixed bitrate the GPU padded every frame up to.
- 270cf9a: Screen recordings are encoded on the GPU (AV1 or VP9 through VA-API) when it can, so a recording near 4K keeps up instead of dropping to about 15 frames a second. Without a GPU encoder they are VP8 on the CPU, as before, with the color conversion now spread over every core.
- 54cd3a0: Screen recordings of a whole monitor or the desk no longer lose frames, which broke playback until the next key frame: a frame that repeats the last frame's timestamp is moved just after it.
- 3acb12b: After a compositor crash, the new compositor launches again the clients Domicile launched that the crash took, on the same Wayland display. Qt 6.6 and later reconnect instead.
- 209873d: A menu its app repositions moves on the page, in the same frame as its new content.
- cd794f9: A native window no longer shows zoomed in while you resize it on a scaled monitor.
- 75799a0: Dragging a window's edge no longer makes its contents jitter. While an `<app>` or `<webview>` has `resizing`, the window's latest frame shows at its own size in the top left corner until the window draws at the new size, instead of being stretched to the new size and then snapping back.
- f1bfea4: Apps such as Electron's keep up better while you drag a window's edge: a window may now have three sizes it has not drawn yet, instead of one, so an app that draws several sizes at once no longer waits for each in turn.
- 79b9aea: A copy restored from the clipboard history moves to the top of it, so the history marks it as what is on the clipboard now.
- 6f85479: Apps no longer crash when a display goes away, such as a TV the desk extended onto. The compositor withdraws a removed display's `wl_output` first and frees it a few seconds later, so an app that binds it in the meantime keeps running.
- e1b6312: The engine is built on a newer Chromium, with its fixes and web platform updates.
- 0f16f99: The engine is built on a newer Chromium, with its fixes and web platform updates.
- 575e7cd: Canceling a page's screen share picker rejects `getDisplayMedia()`, rather than starting a share that ends at once.
- f8c6cc4: A desktop on a second tty or nested in another one no longer breaks the first desktop's portals, notifications or tray. A nested desktop leaves them to its host, and a second login session hands them and the graphical session back when it exits.
- b39d80e: A screen cast that may share a monitor may share a region of one too, so a browser's share picker lets you drag an area.
- 2fe9fb4: A shared screen shows the pointer over the shell's page and browser windows, not only over an app's window.
- 5ef82d2: Apps that ask to share a screen, as Slack and Discord do, can pick a window too.
- ee63a45: The top bar's sharing indicator says what is shared. It is a red "Sharing screen" pill, and its panel lists each source by name with what of it is shared: a window with its application, a screen by make and model, all screens, or part of a screen with its size. A region covering one whole screen is listed as that screen, and one covering every screen as all of them, instead of "Region". `Captured` carries a window's app id, a monitor's description, the monitor a region is on, and a new `Desk` kind.
- 93f015d: The shell's own page can open a file dialog, through the desktop's file picker, and a folder dropped on a page's folder input uploads its files.
- b2004dd: - Sharing from Slack works from Slack's own picker: our picker comes up once, and Slack's second request is canceled instead of taking the same pick.
  - A tiled window that draws at another size than it was given, such as a Slack huddle, is told its size again instead of being stretched.
- 9db9fcb: An app that holds the keyboard can pass it to another of its windows, so Slack's huddle window comes forward when a huddle starts.
- c079b22: Sharing from Slack puts up our picker once: Slack's later asks for windows during the same share are canceled.
- 22213d1: Fix Slack crashing or sharing nothing when sharing a window or the desk: a window picked earlier is no longer handed to a later share, and Slack's second, canceled capture now answers after the pick.
- 067e0c4: Smoother recordings and casts of a whole monitor or the desk: frames are paced on a steady beat instead of dropping one every few dozen, filled once when sent instead of on every engine frame, and drawn on the GPU with one read back instead of reading back and scaling each monitor on the CPU.
- 623fb41: The engine is smaller: it leaves out Chrome's own settings, New Tab page and other pages the desk never opens, WebUI code caches, and, in every language but English, the strings of Chrome's own UI. Web pages' strings stay translated.
- b241f68: A desktop that boots in a different theme from the one its shell remembered no longer stays stuck half faded in and ignoring the pointer. The compositor answers a theme capture with nothing to turn, and a wipe's hold can no longer freeze another view transition.
- 0c58b28: `pointer.warp` takes an `unlessOver` box: the engine leaves the pointer where it is while it is over that box, including over a browser window's page, which the shell cannot see. Manganese passes the newly focused window's frame, so the pointer stays put when it is already on that window.
- eb6b52a: Dragging a browser window's edge no longer holds the whole desktop to the page's pace. While a `<webview>` has the `resizing` attribute, as an `<app>` already could, the page's latest frame stretches to each new box at once instead of the desktop waiting for the page to draw at it. Manganese sets it on every browser window during a resize.
- Updated dependencies [bafd922]
- Updated dependencies [8fa9c05]
- Updated dependencies [3980a9a]
- Updated dependencies [623860a]
- Updated dependencies [a2def76]
- Updated dependencies [9d0934e]
- Updated dependencies [bb92965]
- Updated dependencies [1062efc]
- Updated dependencies [c429bd5]
- Updated dependencies [e455955]
- Updated dependencies [c03a44b]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [ab2d2f0]
- Updated dependencies [ecd3fba]
- Updated dependencies [62a671f]
- Updated dependencies [54472b5]
- Updated dependencies [64b22f3]
- Updated dependencies [e42226f]
- Updated dependencies [75b9403]
- Updated dependencies [b49fa3a]
- Updated dependencies [6730912]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [a113605]
- Updated dependencies [3ded272]
- Updated dependencies [d4b9da4]
- Updated dependencies [be59aae]
- Updated dependencies [9d4a876]
- Updated dependencies [10ee944]
- Updated dependencies [44d0983]
- Updated dependencies [dc90c70]
- Updated dependencies [5bdc699]
- Updated dependencies [cd02e0e]
- Updated dependencies [5e0723d]
- Updated dependencies [8946a22]
- Updated dependencies [3757596]
- Updated dependencies [1ad2756]
- Updated dependencies [93f015d]
- Updated dependencies [e781b22]
- Updated dependencies [6b2a242]
- Updated dependencies [fccc784]
- Updated dependencies [1fcf33a]
- Updated dependencies [2ce51b8]
- Updated dependencies [3146073]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [a5bff8c]
- Updated dependencies [a1f9bb9]
- Updated dependencies [341debf]
- Updated dependencies [ae7874c]
- Updated dependencies [c4fe915]
- Updated dependencies [b1041f8]
- Updated dependencies [45c846a]
- Updated dependencies [0bbe0f9]
- Updated dependencies [33444d9]
- Updated dependencies [e645e06]
- Updated dependencies [f8b1742]
- Updated dependencies [e97b6b2]
- Updated dependencies [0abccd9]
- Updated dependencies [96a82ac]
- Updated dependencies [2d0838f]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [1971d87]
- Updated dependencies [f45bf2b]
- Updated dependencies [4096040]
- Updated dependencies [de5d134]
- Updated dependencies [6c3db42]
- Updated dependencies [e039233]
- Updated dependencies [0c58b28]
- Updated dependencies [d3847ed]
  - @domicile-desktop/app-settings@0.1.0
  - @domicile-desktop/app-history@0.0.2
  - @domicile-desktop/manganese@1.1.0
  - @domicile-desktop/shell-simple@0.0.2
  - @domicile-desktop/shell-splash@0.0.2
  - @domicile-desktop/builder@0.1.0

## 1.0.0

### Major Changes

- 2056529: The first release.

### Minor Changes

- e90c8ad: On a tty, a touchpad ignores input while a keyboard types. `domicile disable-while-typing [on|off|toggle]` turns it off and on.

### Patch Changes

- d32d8f7: A `domicile://` page can `fetch()` its own files, and only its own.
- 0bf1018: The boot splash crossfades straight into the shell instead of through a white page.
- Updated dependencies [2056529]
- Updated dependencies [0ff84ad]
- Updated dependencies [0bf1018]
  - @domicile-desktop/manganese@1.0.0
  - @domicile-desktop/builder@0.0.1
  - @domicile-desktop/shell-simple@0.0.1
  - @domicile-desktop/app-history@0.0.1
  - @domicile-desktop/app-settings@0.0.1
  - @domicile-desktop/shell-splash@0.0.1
