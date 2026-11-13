# @domicile-desktop/manganese-window-management

## 1.4.0

### Minor Changes

- d566f68: A cursor an app draws itself, such as a game's, an image editor's brush or a VM viewer's, now shows in place of the arrow. The compositor sends each image the app commits as a PNG on `app_cursor`, and `DomicileWindow.cursorImage` gives it to the shell as a CSS `cursor` value. Manganese sets it on the window's element.
- 24b88fb: Dragging the title bar or edge an app draws itself, such as a GNOME app's header bar or Firefox's tab strip, moves or resizes its window. The compositor checks the press is still held, takes it from the app, and reports `WindowRequest.Move` or `WindowRequest.Resize` (with a `ResizeEdge`); Manganese runs the drag as it does a Meta drag.
- da632d6: A shell can give you a way back from a VM or remote desktop viewer that holds your shortcuts. A chord bound `--inhibited Meta+Escape` stays the shell's while that window has the keyboard, and `keyboard.switchShortcutsInhibitor` turns the window's hold off and on. Manganese has a `shortcuts-inhibitor toggle` command to bind to it.
- a5ade39: Games and VM viewers can lock the pointer (`zwp_pointer_constraints_v1`). The compositor offers the lock to the shell for the window under the pointer as `pointerConstraint`, and tells the client only once the shell holds a pointer lock on the window's `<app>` and reports it with `windows.pointerConstrained()`. The engine grants a shell's pointer lock with no click first and no browser bubble. Manganese locks for the focused window and lets go when the keyboard moves away. Confining the pointer to a window is offered but not taken yet.
- 9bd54ab: The config can name a terminal with `terminal`, such as `["kitty"]`. When it does, applications that run in a terminal, such as htop and vim, show up in the launcher and under "Open with", and `domicile open` runs them in it. Meta+Return opens it in Manganese. Without one, nothing changes: Domicile still has no default terminal.
- 19cc2c5: Tapping Super on its own opens and closes the overview, as it does on GNOME and KDE. Holding Super for a shortcut, a drag or a scroll still works as before. Shells can bind a tap of any modifier alone by writing just its name, such as `Meta` or `Alt`, in their keybindings.

### Patch Changes

- 3e37020: A client asking to be minimized now reaches the shell as `WindowRequest.Minimize`. The shell can also set `WindowState.Resizing` on a window while it resizes it, and the client sees `resizing` in its configure.
- eaa92c7: Showing a background app's window, such as Messages, plays the opening animation.
- 1209f22: Firefox and Tor Browser windows slide, open, close and ease with the rest of the desktop. A client's popups are drawn with its window and play its motion.
- 6a0772b: A tab dragged out of a nested group drops before or after the group's own tab, including past it when the group is the last tab.
- b5edfcd: A tab opening or closing keeps an edge and shadow while it moves, so it shows over a tab that looks like it.
- 0ee4ce8: The cursor changes over links and text in Firefox and Tor Browser. Both shells show the cursor a client asks for over its popups and bubbles.
- 637cc16: Pages take the mouse right after a window is resized by its edge. A fast resize released over a browser window no longer leaves the resize cursor over its page or sends the next clicks to the desktop.
- 64bda78: Hiding a background app's window, such as Messages, plays the same closing animation as closing any other window.
- 4b7a878: The overview opens and closes more smoothly: the engine no longer waits for hidden workspaces' windows to draw, and opening or closing no longer restyles every part of every window.
- 9ea68bf: A window dropped on the side of a nested group's window splits beside the group, as the overlay shows, instead of joining the outer strip.
- 5090cbd: The drop target and the selection tint draw over Firefox and Tor Browser windows.
- Updated dependencies [d0fbc5b]
- Updated dependencies [d566f68]
- Updated dependencies [87ac040]
- Updated dependencies [24b88fb]
- Updated dependencies [81215c5]
- Updated dependencies [3e37020]
- Updated dependencies [3bdac3b]
- Updated dependencies [2a1913f]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [8c477cc]
- Updated dependencies [996cc29]
- Updated dependencies [9bd54ab]
- Updated dependencies [8ff882e]
- Updated dependencies [25522ef]
- Updated dependencies [e821d1f]
- Updated dependencies [19cc2c5]
  - @domicile-desktop/sdk@2.3.0
  - @domicile-desktop/system-apps@1.3.0
  - @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/manganese-address@1.0.4
  - @domicile-desktop/manganese-host@2.0.3
  - @domicile-desktop/manganese-page-requests@1.2.1
  - @domicile-desktop/manganese-bar@1.1.3

## 1.3.0

### Minor Changes

- 28e836c: Tab groups nest. A selected group moved with Meta+Shift+arrow goes into the next group as a tab, along its tabs, then out past the last one. The new `group` command (Meta+G) turns the focused tab into a group of its own in the same slot.
- 6930e8f: Manganese's touchpad gestures: a three-finger swipe moves focus that way, as Meta+H/J/K/L do. Four fingers now switch workspaces (left and right), and pull the scratchpad down or push it back up (down and up). Shells can bind the scratchpad's two directions with the new `scratchpad bring` and `scratchpad hide` commands.
- c664ef4: Shells bind touchscreen swipes in from a screen's edge, written `edge:left`, `edge:right`, `edge:top`, `edge:bottom` or `edge`, beside their keys and touchpad gestures. A finger landing at an edge the shell binds waits until it is clearly coming in; a scroll or tap there still reaches the app underneath. Manganese swipes between a monitor's workspaces from its side edges.
- 7371c33: In the overview, Meta+H/J/K/L moves between workspaces and Meta+Shift+H/J/K/L swaps the picked one with its neighbor, windows and all. The arrow keys move the way they point. Other window and workspace keys do nothing while it is open.
- 1af639c: File access, client certificate, Bluetooth pairing and extension permission prompts now ask in the shell, over the page, instead of in Chrome's unstyled dialogs drawn over the desktop. Sites in browser windows can now be allowed to edit files they open. `<webview>` fires `domicile-prompt`.
- 62ccd23: Manganese has an overview: each monitor's workspaces at once, with their live windows. Open it with Meta+O, a four-finger pinch in, or the new button before the workspaces in the bar. Click a workspace or a window to go there, or drag a window onto another workspace to move it. A four-finger pinch out opens the launcher, whose button now shows a sparkle that twinkles when pointed at. The component library adds `AnimatedSparkleIcon`.
- bb1e4cb: A page's tooltips, the "send the form again?" question on reload and the "page isn't responding" question are now the shell's, instead of Chrome's. `<webview>` reports its tooltip as `tooltip` with `domicile-tooltip-change`, and `domicile-prompt` gains the `resend-form` and `unresponsive` kinds. Reloading a page a form posted to used to do nothing; it now asks.
- f592184: Shells bind touchpad gestures of three fingers or more beside their keys, in sway's `bindgesture` grammar such as `swipe:3:left`, and in the same modes. `DomicileHost.grabGesture()` and the `gesture` event carry every phase; `domicile.gestures` wraps them. Manganese swipes four fingers between a monitor's workspaces, and gains `workspace next_on_output` and `prev_on_output`.
- 18413ff: A link for an app, such as Zoom or Slack, asks "Open Zoom?" over its page in the shell's style, naming the app and showing its icon, instead of Chrome's unstyled "Open xdg-open?" dialog. A secure site can be let open these links without asking. Shells get `domicile-external-app` on `<webview>`.
- 69fe0d8: A page that can't load, has a certificate problem, is flagged as unsafe or crashes now shows a shell page with Try again, Go back or Continue anyway, instead of Chrome's own error and warning pages. `<webview>` reports why as `pageFailure` with `domicile-page-failure-change`, and `proceedPastWarning()` passes a warning.
- 92a4035: Spreading four fingers closes the overview, and pinching in inside it no longer does: `pinch:4:inward` is `overview show` and `pinch:4:outward` is `overview hide`, both new commands. The launcher moves to a three-finger spread (`pinch:3:outward`).
- a354497: A site or proxy that asks for a username and password now asks in the shell, over the page, instead of in Chrome's unstyled dialog drawn over the desktop. `<webview>` fires `domicile-sign-in`.
- 9246b97: A page's color, date and time pickers and a text box's suggestion list are now drawn by the shell, hung from the control, instead of by Chrome. `<webview>` fires `domicile-picker` with the control's kind, value, suggestions and box, answered with `choose()` or `cancel()`.

### Patch Changes

- 76c4390: Swapping workspaces in the overview slides each workspace's whole tile with its windows, not just the windows.
- cd7e4ba: Hovering a tab group's rail focuses the group's open window.
- b3e7457: Drag a nested group's tab along its strip or out of it, and move other tabs past it. The tab strip above a nested group no longer turns into a resize handle.
- 55194ce: Switching tabs again before the last switch has faded no longer flashes a tab you left earlier, or the desktop, for a frame or two.
- 8375015: Closing a tab in a group now shrinks and fades its contents out, as closing a window does, instead of only crossfading them into the next tab.
- f6dc5b2: Resizing a window by its edge always ends when the mouse button is let go, so the resize cursor no longer sticks and windows take clicks again.
- e2a04a5: Workspace switches and scratchpad slides no longer stall at the start while a heavy page on the incoming workspace draws again.
- 174918e: In the overview, Meta+H/J/K/L now shows which workspace it moved to with a white ring and moves on to the next monitor at the edge, and keys other than the overview's own (and lock, screenshot, volume and brightness) do nothing, so Meta+Enter no longer opens a terminal behind it.
- e2418db: In the overview, the ring round the picked workspace slides with it as it swaps, and Meta+Shift+H/J/K/L swaps with a workspace on the next monitor at the edge. The ring under the pointer is fainter than the picked workspace's, so the two are easy to tell apart.
- 1df09a6: Honor a native client's requested fullscreen display and keep its window on that display when leaving fullscreen.
- 280ce42: A window moving to another tab group slides over the tab strips on its way, not under them.
- f4f993a: A closing window stays under the floating windows over it, instead of flashing above them.
- 87ad25a: Opening and closing a tab in a group is easier to see. A new tab's contents grow out of its tab in the strip and fade in, and a closing tab's shrink back into it, over twice as long as before. Before, a new tab only crossfaded over the tab it hid, and a closing tab barely shrank.
- 56adc6f: The overview opens like a camera pulling back from the workspace you're on: every workspace moves together, the others coming in from the side they sit on, and the names settle in as it lands. Closing pushes back into the workspace you picked.
- Updated dependencies [f9bbf5d]
- Updated dependencies [c664ef4]
- Updated dependencies [1af639c]
- Updated dependencies [eba7d0d]
- Updated dependencies [62ccd23]
- Updated dependencies [af7415e]
- Updated dependencies [bb1e4cb]
- Updated dependencies [c1988f7]
- Updated dependencies [d69b2f4]
- Updated dependencies [e81703a]
- Updated dependencies [8eaae53]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [3d22f74]
- Updated dependencies [a354497]
- Updated dependencies [75708d7]
- Updated dependencies [9246b97]
- Updated dependencies [50318b4]
- Updated dependencies [cdb3534]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/sdk@2.2.0
  - @domicile-desktop/manganese-page-requests@1.2.0
  - @domicile-desktop/system-apps@1.2.0
  - @domicile-desktop/manganese-bar@1.1.2
  - @domicile-desktop/manganese-address@1.0.3
  - @domicile-desktop/manganese-host@2.0.2

## 1.2.0

### Minor Changes

- fdad979: Middle-clicking Back or Forward in a browser window's address bar opens that step in a new window, as Chrome does in a new tab. The new window keeps the page's history, and the window you clicked in stays where it was.
  
  `<webview>` gains `goBackInNewWindow()` and `goForwardInNewWindow()`.

### Patch Changes

- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0
  - @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-address@1.0.2
  - @domicile-desktop/manganese-host@2.0.1
  - @domicile-desktop/manganese-page-requests@1.1.1
  - @domicile-desktop/system-apps@1.1.1
  - @domicile-desktop/manganese-bar@1.1.1

## 1.1.0

### Minor Changes

- aa215a9: Every tiled window is in a tab group, so a new window always opens as a tab. Splitting is a move: Meta+B / Meta+V move the window out of its group to the right / below, Meta+E splits a group's tabs into groups side by side, and Meta+W on a selected split merges its groups. Meta+Shift+arrow moves a window alone in its group into the next group as a tab.
- 66d220b: Show a browser window's zoom and finished downloads in popups that hang from the address bar, as Chrome does. The downloads popup lists each file with Open, Show in folder and Remove from list, and the Downloaded indicator opens it again. `<webview>` gains `downloadCompletedPaths` and `removeCompletedDownload()`; `Popover` gains `anchor` and `quiet`; `ListRow` gains `endOnHover`.
- 9fe15f8: Downloads from every window, browser and app alike, now show in one Downloads item on the bar, shown while there are any. It says how far the downloads in progress have come, and its panel lists each download with where it came from, to cancel, open, show in its folder, or remove. The address bar's downloads chip and the downloads popup over the page are gone.
  
  The engine keeps one list of the desk's downloads, so a download outlives its window. The SDK reads it as `domicile.downloads` (`list`, `cancel`, `remove`, `clear`, and a `change` event); `<webview>`'s per-page download properties, `clearCompletedDownloads`, `removeCompletedDownload` and `downloadschange` are removed.
- e60eb1f: Dropping a window or tab on the middle of another window puts it in that window's tab group, after it, instead of swapping the two. Dropping on any edge of a window in a tab group of one puts the window beside it, rather than into its strip for some edges.
- 2d2289b: Leave closed inboxes' windows out of the screenshot, share and record pickers. `PortalDialogs` takes `closedBrowsers`, the browser windows a shell keeps running but shows as closed; `closedBrowsersOf` lists a manganese desktop's.
- a113605: Inboxes open as app windows instead of a page in the notifications drawer. Messages is one window that keeps running in the background: closing it hides it. Each Gmail account has one window, reused by its inbox row, its bar counter and its new-mail notifications. `Inbox.Page` is replaced by `Inbox.Window`, and an inbox's `launcherName` adds a launcher entry that opens its window.
- 44d0983: Switch keyboard layouts at runtime. `input.keyboard.keymaps` lists named keymaps; the first is the one the desktop starts on. The `keymap next` and `keymap <name>` commands switch every keyboard and show a toast, and the new `Keymap` bar item, in the default bar left of the theme toggle and on the lock screen, shows and switches it. The item's list and the toast show xkb's name for each layout. A switch lasts until the desktop restarts. The shell option `keymap.hideDefault` hides the item on the first keymap, and the Settings app's Keyboard page edits the list.
  
  The component library adds `ChoiceRow` (`RadioRow`, `CheckboxRow` and `ChoiceList`), the screenshot picker's rows as a component, and `ChoiceToast` takes a `detail` line.
- d210cae: A browser window's right-click menu offers Zoom in, Zoom out and, once zoomed, Reset zoom over the page, and names the Back, Forward and Reload chords.
- c15ba93: Shells and manganese packages take the typed `Domicile` instead of the raw host. `PortalDialogs` takes `domicile` (no more `host`/`desktopOf`), `usePortalWallpaper` and manganese-host's helpers take `Domicile` slices, and the SDK's `bindKeys`, `fireGlobalShortcuts`, `watchShellOptions` and `casting` take namespaces. Adds `portals.fireShortcut`.
- f8b1742: New manganese command, for a key or `domicile send-shell`: `night-light` toggles the night light, as the brightness popover's switch does.
- e97b6b2: New manganese commands, for a key or `domicile send-shell`: `virtual-monitor add [<width>x<height>]` adds a monitor with no connector, and `virtual-monitor remove` removes the newest one added.
- 0abccd9: New manganese commands, for a key or `domicile send-shell`: `notifications` toggles the notification drawer, `notifications clear` clears it, and `idle-inhibitor` toggles keeping the screens on.
- 4096040: Pressing a title bar or tab inside a selected group selects just that window. A title bar's float and fullscreen buttons act on their own window, never the selected group, and a tab of a floating group tiles alone. `Stage` takes `onBarPress`, and `WindowAction.WindowBarPressed` is new.
- 570e7bb: Tabs, title bars and the browser's address bar share one look. Titles are 13px with 16px icons. The open tab, the focused title bar and the browser toolbar are one surface (white in light mode) on a darker tab strip, which resting title bars match. A tab shows its float and maximize buttons only under the pointer, and a hidden tab its close button, so titles get the room. The address field is a 13px, tinted, edgeless field until clicked; the padlock is gray; zoom controls show only while a page is zoomed. `Autocomplete` takes `filled`.
- d862eaa: Browser windows show a brief popover over the page when the zoom changes or a download finishes, including app windows and fullscreen pages.

### Patch Changes

- a62f35a: Bar item text (battery, keyboard layout, Gmail, mode, tray letters) is 13px, like the clock. New `fontSizes.ui` token (13px), the desktop's one text size.
- 59b3d65: Center a tab's close button on the tab, level with its title.
- f15f43a: The clipboard history is wider and shows more of each copy: up to four lines of text with its line breaks, and a larger image preview beside its size. What is on your clipboard gets its own group above what was copied before. The compositor previews 480 characters and makes thumbnails up to 256 px. `RowTile` drops its `picture` prop.
- bb92965: Windows moving into a new split or between tiling and floating no longer stretch their contents. The window's box eases into place and crops the contents, which stay at their real size.
- 1062efc: A workspace switch slides normally onto a browser window whose page has a dialog, file picker or find bar open.
- e455955: `domicile open <file|folder|url>` opens anything: a web link in a browser window, anything else with its type's default from `mimeapps.list`, supertypes counted (a `text/plain` default opens Markdown and source code). `domicile open --app <url|module>` opens a site or app module as an app. Domicile's `xdg-open` and the launcher's Enter run it, so apps, terminals and the launcher agree. `open-url`, `open-app` and `run-app` are gone: use `open` and `open --app`.
- 7c948b4: A tab dragged along its strip slides into each new slot instead of jumping there.
- f3cb310: Dragging a window from a drop zone onto a tab strip fades the zone out and the insertion line in, instead of stretching one into the other.
- 62a671f: An extension's `sidePanel.open()` opens its side panel as a tiled window of its own, with no address bar, so Phantom, which opens in its side panel by default from 26.37, opens again. A popup an extension asks for opens under the icon that was clicked, on that monitor, not on the focused one; the tray state gains `clicked`.
- 56e1c22: File picker polish:
  
  - New folder button, and a Hidden files toggle (Ctrl+H).
  - The listing updates when the folder changes.
  - The save name box no longer walks a `/`.
  - No key help in the sidebar; full-size sidebar buttons.
  - Portal labels drop GTK's `_` access key marks ("_Save" shows as "Save").
  - `System.createDir` (`create_dir`) makes a directory. `FileRequest.list` is replaced by `FileRequest.folders` (`systemFolders` in `@domicile-desktop/component-library/folders`).
- e0bf6c2: Keep keyboard focus and stacking on a floating window while it is dragged toward another screen, until its center crosses.
- 7646678: Dragging a floating window to another screen keeps it selected, even while the pointer is still on the screen it left.
- 920763e: A float that trades places with another moves as one: its hidden tabs and nested groups' tabs, strips and wells move with its open tab.
- 98d378e: A page's window opened at a size, such as a Slack huddle, opens floating at that size instead of stretched into a tile.
- 83f9f2d: A floating window dragged over the edge of its monitor stays over the next monitor's floating windows: floats on the monitor with the keyboard stack over every other monitor's.
- 64b22f3: Focus follows the pointer while Meta is held.
- 542a309: Focus follows the pointer into a window however slowly it moves.
- a390b06: A selected tab group keeps its selection tint while fullscreen.
- c9c75a8: A tab group's fullscreen button leaves the selection on the open tab instead of moving it to the group.
- 8bc5b85: Dragging or resizing a window repaints far less: each part of a held window gets its own layer, and the scratchpad's `--lift` is set only while it slides, not on every pointer move.
- 6730912: A browser window hidden behind a tab can be screenshotted, previewed and shared: the engine lists it as `isCaptured` while a capture runs, and manganese keeps it laid out under the shown tab. The screenshot and share pickers keep their size when a pick shows a preview. A shared screen's cursor reaches consumers that read it as metadata, such as Chrome.
- 7a29c8f: Icons in the bar, quick settings and level notices move when their state changes or they are pointed at: the bell swings, Wi-Fi arcs fill out, Bluetooth dots slide out, speaker waves pulse, a slash draws across what is off, the dark mode sun turns to a moon, and more. New `Animated*Icon` components and `_controlHover` / `_controlActive` conditions in the component library. The notifications bar item no longer exports a Panda preset.
- 9b8a4f0: Keep split sizes when `move <direction>` takes a window out of one group and on into the next.
- 452a746: The focused window's ring shows in light mode: a solid accent ring with a pale outer band replaces the faint glow.
- 1ad2756: Volume, microphone and brightness keys show the new level in a notice on the focused screen.
- 93f015d: A page can ask for window management, local fonts, idle detection and automatic downloads. The shell asks the user, and Settings and the site panel show each.
- e781b22: Moving a window into or out of a group nested in a tab moves only that window: the outer tab strip no longer flies out of or into the group's well, and the group's tab eases to its new slot instead of jumping.
- 6b2a242: Nested tab groups animate and light properly: a tab switch or new window in a nested group no longer zooms its strip in from the outer group's, switching away from a nested group no longer shrinks its windows away, and a group selected inside a tab is lit around its own windows.
- 9a0cf19: A divider marks off a tab group's new-tab button from a hidden last tab, as between two hidden tabs.
- 2425185: Keep a newly opened window in front when the window it opened over asks for the keyboard it already has, as when the launcher or drawer closes.
- 1fcf33a: The notification drawer opens as a panel under the bell, like quick settings, instead of sliding in from the screen's edge. Its sections have clearer headings, inbox rows are tighter, and each notification sits on its own tile. "Clear all" is in a quieter footer. An inbox's page, such as Messages, widens the panel and has a back button.
  
  `NotificationsDrawer` (from `notifications-context`) now holds a popover `handle` that every bell opens, in place of `open(screen)`. `NotificationDrawer` takes `handle`, `onOpen(screen)` and `onClose()` in place of `onOpenChange`.
- c4b7781: Keep a tab broken out of its group opaque while it grows into a title bar.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- d95ffb2: Fix a zoom right after a finished download's notice faded showing that notice again instead of the zoom level.
- 48ab992: A browser window's file picker keeps the keyboard when the waiting page takes focus, so typing a name works after saving from the PDF viewer.
- 3bb9bd5: A download's file picker starts in the download folder (`XDG_DOWNLOAD_DIR`). The file chooser event has `currentFolder`.
- d80e2f5: Popups stay inside their window. `PopupBoundary` keeps every tooltip, popover, menu and list inside it within its box; `Popover` and `Tooltip` take `spansWindows` to leave it. Each window and tab keeps its popups inside its frame, so a tab's tooltip no longer covers the windows beside it. `test-support/popup-layout` fakes the layout a popup is placed by.
- 58d2cfe: A browser window's zoom popup no longer closes when Reset is pressed, and stays up while the pointer is anywhere over it. Its zoom and downloads popups close when another window takes the focus or another tab covers the page. A download's name runs into the room its buttons take until the pointer comes. `Popover` takes `onHoverChange`.
- 2fe5852: Everything that took `system(domicile)` takes `desktop(domicile)`, or the namespace it calls.
  
  - SDK: `keyboard.keymaps` and `keyboard.selectKeymap`. `watchMenu`, `readIconTheme`, `watchIconTheme` and `previewFile` take `{ dbus }` or `{ files }`. `MenuSystem`, `IconThemeSystem` and `PreviewSystem` are `MenuDesktop`, `IconThemeDesktop` and `PreviewDesktop`.
  - system-apps: functions take `AppsDesktop` (`./apps-desktop`). `./fake-system`'s `fakeSystem` is `./fake-desktop`'s `fakeDesktop`.
  - component-library: `AppChooser`'s `system` prop is `domicile`; `PortalDialogs`' `systemOf` is `desktopOf`, and its `host` is a whole `DomicileHost`; `systemFolders` is `desktopFolders`, over `domicile.files`; `usePictureUrl` and `useApps` take `domicile.files` and `AppsDesktop`.
- 50f2549: `search-clipboard` (Meta+Shift+Space) opens a private window when the active window is private.
- 45c846a: The Meta+A selection tint covers a tab group's open tab too.
- 0bbe0f9: An accent tint covers the container Meta+A selects, tabs and windows included. It replaces the accent line along a selected group's tabs.
- acfe355: A tab sent to another workspace shrinks and fades away with its window, as a sent window does, rather than closing up as if closed. A tab group sent away leaves as one.
- ca8979b: Meta+A and Meta+Shift+A skip a tab group holding one window, so selecting up from a lone window selects the windows around it.
- dc66097: Smooth layout eases, such as toggling floating: the page no longer waits for a client to draw before the ease starts, no frame is stretched, and a shrinking window crops its contents instead of showing a gap inside its edge.
- 25b9bd3: Draw the Sound panel's device pickers as soft rows that match the panel.
  
  - `component-library`: `Select` takes `surface`: `field` (the default), `filled` (a soft row sized like a panel's `ListRow`, with an up-and-down caret) or `quiet`. `surface="quiet"` replaces the `quiet` prop. Inside a panel over the wallpaper, its list is dark in either theme, as the panel is.
  - `manganese-bar-module-volume`: the speaker, microphone, app and sound card pickers are `filled`.
  - `manganese-window-management`: site permission pickers use `surface="quiet"`.
- 6a34b99: Pressing or dragging the empty end of a tiled tab strip no longer selects the whole group. It focuses the open tab and keeps any selection already around it; the drag still moves the whole group.
- da8b0a7: Dropping a dragged tab group no longer selects the whole group. The group's open tab is focused, and the group stays selected only if it was selected before the drag.
- 48d5b1a: A tab moved out of its group grows into its title bar from the whole tab strip, so the desktop no longer shows through beside it.
- 559480f: Show the grabbing pointer only once a dragged window moves, so a click on a tab or title bar shows none.
- f45bf2b: Dragging a window over any part of a tab strip adds it as a tab beside the nearest tab, shown as a line between the tabs. The drop overlay is drawn over open tabs.
- 078546d: A window dropped into a tab group no longer leaves the group's tab rail see-through while the window's old rail flies over to it.
- 46f285a: Keep a tab group's focus glow steady while its tabs are reordered, instead of flashing.
- b741b92: The title of the window being worked in keeps its heavier look without shifting sideways when focus moves: a stroke under the letters replaces the medium weight. Adds the `borderWidths.fauxMedium` token.
- 0c58b28: `pointer.warp` takes an `unlessOver` box: the engine leaves the pointer where it is while it is over that box, including over a browser window's page, which the shell cannot see. Manganese passes the newly focused window's frame, so the pointer stays put when it is already on that window.
- d3847ed: The pointer stays put when focus moves to a window that lands under it, title bar included, such as a neighbor sliding in after a close.
- eb6b52a: Dragging a browser window's edge no longer holds the whole desktop to the page's pace. While a `<webview>` has the `resizing` attribute, as an `<app>` already could, the page's latest frame stretches to each new box at once instead of the desktop waiting for the page to draw at it. Manganese sets it on every browser window during a resize.
- 63728a9: Window and browser icons move too. Tabs and title bars: Close snips, New tab reaches out, Float's windows lift apart and gather into Tile's squares, Maximize's corners push out and travel into Restore's, and a group's new layout builds in. Browser toolbar: Back and Forward dart, Reload winds and spins into Stop, zoom's minus and plus draw in and reach out, the lock snaps shut on a secure page, site settings' knobs slide, and each new download drops into its tray. New `AnimatedCloseIcon`, `AnimatedPlusIcon`, `AnimatedMinusIcon`, `AnimatedFloatIcon`, `AnimatedMaximizeIcon`, `AnimatedLayoutIcon`, `AnimatedCaretIcon`, `AnimatedReloadIcon`, `AnimatedLockIcon`, `AnimatedSlidersIcon` and `AnimatedDownloadIcon`, and a `direction` for icon parts.
- bc587f5: A browser window's zoom popup is drawn inside the window, over its page only, instead of in a portal over the desktop. Pressing Reset no longer closes it before the press lands, and it no longer flashes over another window when windows switch.
- Updated dependencies [bafd922]
- Updated dependencies [fe90bca]
- Updated dependencies [77fd631]
- Updated dependencies [9e60e1e]
- Updated dependencies [6bbc80b]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [c7a232d]
- Updated dependencies [66d220b]
- Updated dependencies [a2def76]
- Updated dependencies [d3a65c5]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [7c8d9e2]
- Updated dependencies [fc3ee2f]
- Updated dependencies [9d0934e]
- Updated dependencies [a9a62e8]
- Updated dependencies [fa78a81]
- Updated dependencies [509f948]
- Updated dependencies [a2ee8ea]
- Updated dependencies [22844b3]
- Updated dependencies [c80cd2a]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [aeb6f92]
- Updated dependencies [40f5af3]
- Updated dependencies [ab2d2f0]
- Updated dependencies [17064a7]
- Updated dependencies [a88ce23]
- Updated dependencies [ecd3fba]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [a1569c6]
- Updated dependencies [6fecbbd]
- Updated dependencies [258d9aa]
- Updated dependencies [d9f5353]
- Updated dependencies [fb9e591]
- Updated dependencies [14e6071]
- Updated dependencies [56e1c22]
- Updated dependencies [98d378e]
- Updated dependencies [54472b5]
- Updated dependencies [e42226f]
- Updated dependencies [506b12f]
- Updated dependencies [00e5da2]
- Updated dependencies [75b9403]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [35b8470]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [a999398]
- Updated dependencies [9d4a876]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [e612f06]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [57b5b1f]
- Updated dependencies [b2c6fd5]
- Updated dependencies [a472a59]
- Updated dependencies [93f015d]
- Updated dependencies [b85d9bb]
- Updated dependencies [fccc784]
- Updated dependencies [2bf4b18]
- Updated dependencies [e1205bb]
- Updated dependencies [40d7378]
- Updated dependencies [670713c]
- Updated dependencies [cd52ce3]
- Updated dependencies [e7cbd52]
- Updated dependencies [8bc5b85]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [bbf849b]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [4759ab2]
- Updated dependencies [3bb9bd5]
- Updated dependencies [0f4582e]
- Updated dependencies [d80e2f5]
- Updated dependencies [58d2cfe]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [a5bff8c]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [d138939]
- Updated dependencies [4064278]
- Updated dependencies [f4a973d]
- Updated dependencies [341debf]
- Updated dependencies [ae7874c]
- Updated dependencies [599d60f]
- Updated dependencies [74a9564]
- Updated dependencies [75799a0]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [c4fe915]
- Updated dependencies [b1041f8]
- Updated dependencies [20a1fc5]
- Updated dependencies [065ff4b]
- Updated dependencies [1e2aeca]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [66bfb0d]
- Updated dependencies [5a6a4fc]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [d9f5353]
- Updated dependencies [1971d87]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [6c3db42]
- Updated dependencies [9c89f16]
- Updated dependencies [ca86667]
- Updated dependencies [0c58b28]
- Updated dependencies [ee1cc17]
- Updated dependencies [eb6b52a]
- Updated dependencies [63728a9]
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/sdk@2.0.0
  - @domicile-desktop/manganese-bar@1.1.0
  - @domicile-desktop/manganese-host@2.0.0
  - @domicile-desktop/system-apps@1.1.0
  - @domicile-desktop/manganese-page-requests@1.1.0
  - @domicile-desktop/manganese-address@1.0.1

## 1.0.0

### Major Changes

- 2056529: The first release.

### Patch Changes

- c705ff5: `loadEmittedStylesheet` removes its stylesheet once the enclosing file or `describe` has run. Test files share one document, so stylesheets left behind slowed every later file's style lookups until `BrowserWindow`'s context-menu tests timed out in CI. `BrowserWindow`'s tests load it only where they read a style.
- Updated dependencies [2056529]
  - @domicile-desktop/component-library@1.0.0
  - @domicile-desktop/manganese-address@1.0.0
  - @domicile-desktop/manganese-bar@1.0.0
  - @domicile-desktop/manganese-host@1.0.0
  - @domicile-desktop/manganese-page-requests@1.0.0
  - @domicile-desktop/sdk@1.0.0
  - @domicile-desktop/system-apps@1.0.0
