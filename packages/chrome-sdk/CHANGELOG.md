# @domicile-desktop/sdk

## 2.3.0

### Minor Changes

- d0fbc5b: Turn your monitors off on demand with `domicile sleep-displays`, and back on with any key, click or pointer move, or `domicile wake-displays`. Your windows and workspaces stay where they were. Shells get the same through `displays.sleep()` and `displays.wake()`.
- d566f68: A cursor an app draws itself, such as a game's, an image editor's brush or a VM viewer's, now shows in place of the arrow. The compositor sends each image the app commits as a PNG on `app_cursor`, and `DomicileWindow.cursorImage` gives it to the shell as a CSS `cursor` value. Manganese sets it on the window's element.
- 87ac040: The compositor serves `xdg-system-bell-v1`, so a terminal's bell reaches the shell. `domicile.windows.bells()` streams each ring with the `appId` of the window that rang.
- 24b88fb: Dragging the title bar or edge an app draws itself, such as a GNOME app's header bar or Firefox's tab strip, moves or resizes its window. The compositor checks the press is still held, takes it from the app, and reports `WindowRequest.Move` or `WindowRequest.Resize` (with a `ResizeEdge`); Manganese runs the drag as it does a Meta drag.
- 81215c5: A shell can name any window to a capture tool. Each window's `toplevelId` and each browser window's `toplevelId` is its identifier on `ext-foreign-toplevel-list-v1`, so a shell can hand it to a tool such as `grim -T` instead of matching by title. The compositor sends a native window's on `app_appeared` and the browser windows' on `browser_toplevel_ids`.
- 3e37020: A client asking to be minimized now reaches the shell as `WindowRequest.Minimize`. The shell can also set `WindowState.Resizing` on a window while it resizes it, and the client sees `resizing` in its configure.
- 3bdac3b: `KeyAction.Hold(press, release)` runs one action when a chord is pressed and another when it is let go, such as showing an overlay only while a key is held. The release runs even if the binding mode changed meanwhile.
- 2a1913f: A display profile can set a monitor's mode and refresh rate. `mode: [W, H]` now lights the monitor at that size, refusing the profile when the monitor does not offer it, and the new `refresh` (in Hz) picks the nearest rate the monitor offers. The SDK's `Display` gains `refreshMhz`, the rate the monitor scans out at.
- da632d6: A shell can give you a way back from a VM or remote desktop viewer that holds your shortcuts. A chord bound `--inhibited Meta+Escape` stays the shell's while that window has the keyboard, and `keyboard.switchShortcutsInhibitor` turns the window's hold off and on. Manganese has a `shortcuts-inhibitor toggle` command to bind to it.
- a5ade39: Games and VM viewers can lock the pointer (`zwp_pointer_constraints_v1`). The compositor offers the lock to the shell for the window under the pointer as `pointerConstraint`, and tells the client only once the shell holds a pointer lock on the window's `<app>` and reports it with `windows.pointerConstrained()`. The engine grants a shell's pointer lock with no click first and no browser bubble. Manganese locks for the focused window and lets go when the keyboard moves away. Confining the pointer to a window is offered but not taken yet.
- 8c477cc: Name a monitor to turn only that one off, like `domicile sleep-displays DP-1`. It keeps its windows and workspace, and stays off while you use the others until `domicile wake-displays DP-1`. Shells pass the name to `displays.sleep()` and `displays.wake()`.
- 996cc29: A shell can hear when nobody has been at the desk for a time it chooses (`session.idleAfter`), or a time before the screens blank (`session.idleBeforeBlanking`). These replace `session.idleWarnings` and the `idle.warn_before_seconds` setting, which are gone.
- 9bd54ab: The config can name a terminal with `terminal`, such as `["kitty"]`. When it does, applications that run in a terminal, such as htop and vim, show up in the launcher and under "Open with", and `domicile open` runs them in it. Meta+Return opens it in Manganese. Without one, nothing changes: Domicile still has no default terminal.
- 8ff882e: Extensions can run in private windows. Each extension's chrome://extensions settings are now yours to set: whether it runs in private windows and on local files, whether it may run user scripts, and which sites it runs on (when you click it, on specific sites, or on all sites). Set them in the config's `extensions.settings`, by extension id, or in the Settings app, which shows the ones an extension can use while it is on and moves Options and Uninstall to the bottom of its row. A setting the config drops goes back to Chrome's default.
- 25522ef: Set how held keys repeat with `input.keyboard.repeat` (`delay_ms`, `rate`; 0 turns repeat off). Native windows and pages follow it, and a reload applies it without resending the keymap. The default is 500 ms and 25 a second.
- e821d1f: A display profile can turn on adaptive sync (variable refresh rate, FreeSync, G-Sync Compatible) per monitor with `adaptive_sync: true`. It is off by default, asked for only where the monitor and driver report support, and retried without it when the driver refuses the modeset. The SDK's `Display` gains `adaptiveSync` (`unsupported`, `off` or `on`), which says what the hardware is doing. Settings now reads profiles that set `refresh` or `adaptive_sync` instead of refusing them.
- 19cc2c5: Tapping Super on its own opens and closes the overview, as it does on GNOME and KDE. Holding Super for a shortcut, a drag or a scroll still works as before. Shells can bind a tap of any modifier alone by writing just its name, such as `Meta` or `Alt`, in their keybindings.

## 2.2.0

### Minor Changes

- c664ef4: Shells bind touchscreen swipes in from a screen's edge, written `edge:left`, `edge:right`, `edge:top`, `edge:bottom` or `edge`, beside their keys and touchpad gestures. A finger landing at an edge the shell binds waits until it is clearly coming in; a scroll or tap there still reaches the app underneath. Manganese swipes between a monitor's workspaces from its side edges.
- 1af639c: File access, client certificate, Bluetooth pairing and extension permission prompts now ask in the shell, over the page, instead of in Chrome's unstyled dialogs drawn over the desktop. Sites in browser windows can now be allowed to edit files they open. `<webview>` fires `domicile-prompt`.
- eba7d0d: Night-light apps such as gammastep and wl-gammarelay-rs work: Domicile speaks `wlr-gamma-control`, so each can warm, dim or curve each monitor on its own. While an app holds a monitor, the shell's night light leaves it alone, and takes it back when the app lets go. `displays.setColorTemperature(kelvin, display)` warms one monitor by name.
- af7415e: Hide the pointer while typing and after a pause in pointer input, with `theme.cursor_hide_when_typing` and `theme.cursor_hide_after_ms`. The next pointer move, click, scroll or touchpad gesture shows it again.
- bb1e4cb: A page's tooltips, the "send the form again?" question on reload and the "page isn't responding" question are now the shell's, instead of Chrome's. `<webview>` reports its tooltip as `tooltip` with `domicile-tooltip-change`, and `domicile-prompt` gains the `resend-form` and `unresponsive` kinds. Reloading a page a form posted to used to do nothing; it now asks.
- 8eaae53: Configure touchpad tapping, clicking, scrolling and typing suppression, and mouse acceleration and scrolling, through the desktop config. Choose native libinput typing suppression or configurable pauses. Apply settings on reload and device reconnection.
- f592184: Shells bind touchpad gestures of three fingers or more beside their keys, in sway's `bindgesture` grammar such as `swipe:3:left`, and in the same modes. `DomicileHost.grabGesture()` and the `gesture` event carry every phase; `domicile.gestures` wraps them. Manganese swipes four fingers between a monitor's workspaces, and gains `workspace next_on_output` and `prev_on_output`.
- 18413ff: A link for an app, such as Zoom or Slack, asks "Open Zoom?" over its page in the shell's style, naming the app and showing its icon, instead of Chrome's unstyled "Open xdg-open?" dialog. A secure site can be let open these links without asking. Shells get `domicile-external-app` on `<webview>`.
- 69fe0d8: A page that can't load, has a certificate problem, is flagged as unsafe or crashes now shows a shell page with Try again, Go back or Continue anyway, instead of Chrome's own error and warning pages. `<webview>` reports why as `pageFailure` with `domicile-page-failure-change`, and `proceedPastWarning()` passes a warning.
- a354497: A site or proxy that asks for a username and password now asks in the shell, over the page, instead of in Chrome's unstyled dialog drawn over the desktop. `<webview>` fires `domicile-sign-in`.
- 9246b97: A page's color, date and time pickers and a text box's suggestion list are now drawn by the shell, hung from the control, instead of by Chrome. `<webview>` fires `domicile-picker` with the control's kind, value, suggestions and box, answered with `choose()` or `cancel()`.

### Patch Changes

- d69b2f4: A page's notification names its browser window, so only the Gmail inbox's own window has its duplicate notifications cleared; Gmail in another window notifies again.
- cdb3534: Stop touchpad flicks in native apps from scrolling far past where you aimed. Native apps get libinput's scroll distance and run their own momentum; scroll acceleration now applies to pages only.

## 2.1.0

### Minor Changes

- fdad979: Middle-clicking Back or Forward in a browser window's address bar opens that step in a new window, as Chrome does in a new tab. The new window keeps the page's history, and the window you clicked in stays where it was.
  
  `<webview>` gains `goBackInNewWindow()` and `goForwardInNewWindow()`.

## 2.0.0

### Major Changes

- 9fe15f8: Downloads from every window, browser and app alike, now show in one Downloads item on the bar, shown while there are any. It says how far the downloads in progress have come, and its panel lists each download with where it came from, to cancel, open, show in its folder, or remove. The address bar's downloads chip and the downloads popup over the page are gone.
  
  The engine keeps one list of the desk's downloads, so a download outlives its window. The SDK reads it as `domicile.downloads` (`list`, `cancel`, `remove`, `clear`, and a `change` event); `<webview>`'s per-page download properties, `clearCompletedDownloads`, `removeCompletedDownload` and `downloadschange` are removed.

### Minor Changes

- fe90bca: App windows can belong to an app id, and a launch can reuse that app's open window instead of opening another: `domicile open --app --id <id> --reuse focus|navigate <url>`, or `browser.openApp(url, { id, reuse })`. Windows list their `appId`. `browser.countMatches(id, selector)` counts elements in a browser window's page, hidden or not.
- 3980a9a: A `Cast` bar item lists the TVs nearby: extend the desktop onto one, or cast what the share picker picks to it. `@domicile-desktop/sdk/cast` runs the casts, and `<PortalDialogs />` answers a cast's own ScreenCast request. No backend finds TVs yet, so the item stays hidden.
- 66d220b: Show a browser window's zoom and finished downloads in popups that hang from the address bar, as Chrome does. The downloads popup lists each file with Open, Show in folder and Remove from list, and the Downloaded indicator opens it again. `<webview>` gains `downloadCompletedPaths` and `removeCompletedDownload()`; `Popover` gains `anchor` and `quiet`; `ListRow` gains `endOnHover`.
- d3a65c5: Clipboard history rows say whether a copy is an image: `DomicileClipboardEntry.image` is true for an image with no text, and manganese's clipboard history draws those rows with an image glyph.
- eca2588: Clipboard history rows show a thumbnail of a copied image: `DomicileClipboardEntry.thumbnail` is a small PNG `data:` URL (empty for none; the SDK gives `undefined`), and `RowTile` takes a `picture` to draw in place of its glyph.
- 40f5af3: The engine casts the desktop to Google Cast TVs: `domicile.googleCast` lists them, and casts to them and stops. `engineCast(domicile.googleCast)` in `@domicile-desktop/sdk/cast` is its backend, and the `Cast` bar item uses it, so it shows when a TV is near.
- ab2d2f0: The engine hands `Shell` the typed `Domicile` and an app's `main` the `AppDomicile`, built by the SDK's layer, which the engine bundles. Shells and apps no longer call `desktop()`/`appDesktop()`. The SDK drops `system()`, the portal watch helpers and `./appearance` from its public API; use the `Domicile` namespaces.
- ecd3fba: An extension's `action.openPopup()` opens its popup in the tray, so Phantom's tray button opens Phantom. The SDK reports the request as `extensions.on("popup")`.
- 0e8c788: Extension popups size themselves as in Chrome: Blink's auto-resize, between 25x25 and 800x600. Phantom no longer grows wider on every layout, and Solflare gets its full 402x600. The tray shows a popup once its page has loaded, so it no longer opens narrow and then jumps. `contentWidth` and `contentHeight` report only for an `extensionpopup` view. `Popover` takes `withheld`, to lay a panel out before showing it.
- 56e1c22: File picker polish:
  
  - New folder button, and a Hidden files toggle (Ctrl+H).
  - The listing updates when the folder changes.
  - The save name box no longer walks a `/`.
  - No key help in the sidebar; full-size sidebar buttons.
  - Portal labels drop GTK's `_` access key marks ("_Save" shows as "Save").
  - `System.createDir` (`create_dir`) makes a directory. `FileRequest.list` is replaced by `FileRequest.folders` (`systemFolders` in `@domicile-desktop/component-library/folders`).
- e42226f: `theme.force_dark` names sites, such as `mail.google.com`, that the browser draws dark with Chromium's automatic dark mode while the theme is dark, for sites with no dark theme of their own.
- 35b8470: The Google Messages item counts unread conversations read from the page, including ones that were unread before the desktop started, rather than counting its notifications. `<webview>` gains `countMatches(selector)`, which counts the elements in its page that match a CSS selector.
- 6730912: A browser window hidden behind a tab can be screenshotted, previewed and shared: the engine lists it as `isCaptured` while a capture runs, and manganese keeps it laid out under the shown tab. The screenshot and share pickers keep their size when a pick shows a preview. A shared screen's cursor reaches consumers that read it as metadata, such as Chrome.
- a999398: The keep awake panel draws each app's own icon. `idleHolds` now hears app ids, for the shell to name and draw with `useApps`, instead of names.
- 9d4a876: The keep awake pill names the website a browser window keeps the screens on for ("Kept awake by youtube.com"), with its icon, instead of the engine. `<webview>` gains `wakeLock` and `domicile-wake-lock-change`, and the compositor lists the engine's own hold as `domicile-browser`.
- 44d0983: Switch keyboard layouts at runtime. `input.keyboard.keymaps` lists named keymaps; the first is the one the desktop starts on. The `keymap next` and `keymap <name>` commands switch every keyboard and show a toast, and the new `Keymap` bar item, in the default bar left of the theme toggle and on the lock screen, shows and switches it. The item's list and the toast show xkb's name for each layout. A switch lasts until the desktop restarts. The shell option `keymap.hideDefault` hides the item on the first keymap, and the Settings app's Keyboard page edits the list.
  
  The component library adds `ChoiceRow` (`RadioRow`, `CheckboxRow` and `ChoiceList`), the screenshot picker's rows as a component, and `ChoiceToast` takes a `detail` line.
- 57b5b1f: A watch's and a D-Bus match's `items` are `Listened<T>`: `Listened.Heard(item)`, or `Listened.Missed()` after a compositor restart, when changes in between were not heard. The battery, Bluetooth, network, tray menu and icon theme readers read again then.
- b2c6fd5: Cast the desktop to Miracast TVs (Fire TV, Roku, Samsung, LG, Windows wireless displays) over Wi-Fi Direct or the LAN. The new `domicile-miracast` service runs each cast; `miracastCast(domicile)` in `@domicile-desktop/sdk/miracast` is its backend, and the `Cast` bar item lists its TVs.
- 93f015d: A page can ask for window management, local fonts, idle detection and automatic downloads. The shell asks the user, and Settings and the site panel show each.
- b85d9bb: Name what keeps the screens on. A new `idle_holds` system call (`session.idleHolds()` in the SDK) lists the windows and applications holding idle inhibitors, and the bar's eye opens and names them. The compositor logs each change, and the input that restarts the idle clock when it was getting close to blanking or locking, naming the event and device for the browser's own input.
- fccc784: Automatic brightness and a night light, as on macOS. The backlight follows the room's light from iio-sensor-proxy and learns from the levels the user sets. The night light warms every monitor from sunset to sunrise in the time zone's city, or on custom hours, with a switch in the brightness popover. Both are on by default and set in the Settings app's Shell page or under `shell_options`. Shells set the color temperature with `domicile.displays.setColorTemperature(kelvin)`.
- bbf849b: A client can ask to be laid out at a named place in the shell's page (`domicile_anchor_v1`). Shells read it as `DomicileWindow.anchor`.
- 3bb9bd5: A download's file picker starts in the download folder (`XDG_DOWNLOAD_DIR`). The file chooser event has `currentFolder`.
- c15ba93: Shells and manganese packages take the typed `Domicile` instead of the raw host. `PortalDialogs` takes `domicile` (no more `host`/`desktopOf`), `usePortalWallpaper` and manganese-host's helpers take `Domicile` slices, and the SDK's `bindKeys`, `fireGlobalShortcuts`, `watchShellOptions` and `casting` take namespaces. Adds `portals.fireShortcut`.
- 2fe5852: Everything that took `system(domicile)` takes `desktop(domicile)`, or the namespace it calls.
  
  - SDK: `keyboard.keymaps` and `keyboard.selectKeymap`. `watchMenu`, `readIconTheme`, `watchIconTheme` and `previewFile` take `{ dbus }` or `{ files }`. `MenuSystem`, `IconThemeSystem` and `PreviewSystem` are `MenuDesktop`, `IconThemeDesktop` and `PreviewDesktop`.
  - system-apps: functions take `AppsDesktop` (`./apps-desktop`). `./fake-system`'s `fakeSystem` is `./fake-desktop`'s `fakeDesktop`.
  - component-library: `AppChooser`'s `system` prop is `domicile`; `PortalDialogs`' `systemOf` is `desktopOf`, and its `host` is a whole `DomicileHost`; `systemFolders` is `desktopFolders`, over `domicile.files`; `usePictureUrl` and `useApps` take `domicile.files` and `AppsDesktop`.
- 52a1d65: The screenshot and screen share pickers draw a window that is not on screen, such as a tab behind another, in place of the desk when it is picked. `System.previewWindow` draws one, through the compositor's new `preview_window` system call.
- 3e5b976: The print dialog labels every option and saves to PDF: pick "Save to PDF" as the destination, then where to save it.
- 2430e48: Screen recording: `domicile screen-record` and the Screen Record launcher entry pick a screen, window or region and record it with its sound to `~/Videos/Screen recordings/`, with a floating toolbar (pause, resume, stop, discard) left out of the recording.
- 9fd298a: The screen share picker offers browser windows, streaming the page alone, and previews each source on the desk. The screenshot picker shows the same preview tiles.
- 20a1fc5: `desktop(domicile)` (`@domicile-desktop/sdk/desktop/desktop`) builds the desktop as one typed object, a namespace per subject: `windows`, `browser`, `displays`, `keyboard`, `pointer`, `theme`, `appearance`, `session`, `clipboard`, `tray`, `notifications`, `extensions`, `portals`, `files`, `processes`, `dbus`, `capture` and `shell`. Values are `undefined` rather than `null`, and each namespace's events come through `on`, which returns its unsubscribe. `appDesktop(host)` does the same for an app module.
- ee63a45: The top bar's sharing indicator says what is shared. It is a red "Sharing screen" pill, and its panel lists each source by name with what of it is shared: a window with its application, a screen by make and model, all screens, or part of a screen with its size. A region covering one whole screen is listed as that screen, and one covering every screen as all of them, instead of "Region". `Captured` carries a window's app id, a monitor's description, the monitor a region is on, and a new `Desk` kind.
- d9f5353: `stat` reports `realPath`, the path with every link resolved, so two paths to one file compare equal. The file dialog uses it to list a user folder once when a link leads a second one to it.
- 6c3db42: A virtual monitor can be resized in place with `resize`, keeping its output, windows and casts.
- 9c89f16: A virtual monitor can have a scale of its own, such as 1.5, when added or resized (`addVirtualMonitor` and `resize` take `scale`).
- ca86667: A shell can add a monitor with no connector, which the desk extends onto and only a capture shows, with `system(domicile).addVirtualMonitor()`. Casting to a TV extends the desk this way.
- 0c58b28: `pointer.warp` takes an `unlessOver` box: the engine leaves the pointer where it is while it is over that box, including over a browser window's page, which the shell cannot see. Manganese passes the newly focused window's frame, so the pointer stays put when it is already on that window.
- ee1cc17: `<webview partition="persist:name">` gives a page storage of its own, kept on disk; any other name keeps it in memory. `openBrowserWindow(url, partition)` opens a window in one, listed with its `partition`. A page's own navigation fires a cancelable `domicile-will-navigate` first.

### Patch Changes

- 22844b3: Docs audit: Wayland-only app support and the apps we check, the config schema served from domicile-desktop.com, locking in a `nix run` trial, portal requests a shell must answer, a complete packaging example, GPU troubleshooting for users, a NixOS flake example, differences from Chrome, and contributor-only sections labeled in the package references.
- 17064a7: A browser window whose `<webview>` moves in the shell's document shows its page again where it lands. Before, the page stayed detached and the window froze, which happened when a window crossed monitors while being resized.
- a88ce23: The engine is a workspace package: its shell tests run in `test:shell`, and its checks against a built tree in `test:engine`.
- 62a671f: An extension's `sidePanel.open()` opens its side panel as a tiled window of its own, with no address bar, so Phantom, which opens in its side panel by default from 26.37, opens again. A popup an extension asks for opens under the icon that was clicked, on that monitor, not on the focused one; the tray state gains `clicked`.
- 98d378e: A page's window opened at a size, such as a Slack huddle, opens floating at that size instead of stretched into a tile.
- 2a87739: The screenshot and screen cast pickers take a part of a window that is not on screen, dragged over its preview.
- 2bf4b18: A desktop whose machine lacks the lock's PAM service, such as a `nix run` trial, does not lock: locked, nothing could unlock it. An urgent notification, "This screen won't lock", says so at startup, and the log names the file to add. Adding it turns the lock on with no restart. The Manganese page notes this under its trial command.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- 75799a0: Dragging a window's edge no longer makes its contents jitter. While an `<app>` or `<webview>` has `resizing`, the window's latest frame shows at its own size in the top left corner until the window draws at the new size, instead of being stretched to the new size and then snapping back.
- b1041f8: The last package-specific scripts leave `scripts/`: `dev-shell` becomes a package the shells' `start:dev` runs, docs media capture moves into the site, `update-engine-release.sh` and the IDL check into the engine, and `smoke-compositor.sh` into the e2e harness.
- 66bfb0d: Shell and app examples, on the site and in the docs, come in React and in plain JavaScript, with a plain JavaScript example shell beside the React one.
- eb6b52a: Dragging a browser window's edge no longer holds the whole desktop to the page's pace. While a `<webview>` has the `resizing` attribute, as an `<app>` already could, the page's latest frame stretches to each new box at once instead of the desktop waiting for the page to draw at it. Manganese sets it on every browser window during a resize.

## 1.0.0

### Major Changes

- 2056529: The first release.
