# @domicile-desktop/manganese-launcher

## 1.2.0

### Minor Changes

- 9bd54ab: The config can name a terminal with `terminal`, such as `["kitty"]`. When it does, applications that run in a terminal, such as htop and vim, show up in the launcher and under "Open with", and `domicile open` runs them in it. Meta+Return opens it in Manganese. Without one, nothing changes: Domicile still has no default terminal.

### Patch Changes

- a9b83d4: The launcher's empty box names a few site codes: "Try !yt, !wiki or !gh."
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

## 1.1.2

### Patch Changes

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
  - @domicile-desktop/system-apps@1.2.0
  - @domicile-desktop/manganese-address@1.0.3
  - @domicile-desktop/manganese-host@2.0.2

## 1.1.1

### Patch Changes

- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0
  - @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/manganese-address@1.0.2
  - @domicile-desktop/manganese-host@2.0.1
  - @domicile-desktop/system-apps@1.1.1

## 1.1.0

### Minor Changes

- f71cc09: The Downloads bar item's panel opens by itself as a download starts, on the screen with the keyboard, and stays until dismissed. Removed downloads slide out as cleared notifications do. As the last download finishes, the item eases from its percent to a check and "Done", then back to its icon. Opening a file no app opens says so, in the downloads panel and in the launcher, instead of doing nothing.
  
  - `LeavingRow` and `useLeavingRows` (component library) hold the notification drawer's arrive and leave motion; `ListRow` takes it as `motion`.
  - `Bar` has `popsUp`: whether an item may open its panel by itself.
  - `opens` and `nothingOpens` (`@domicile-desktop/system-apps/opens`) ask `domicile open --which` before opening a file.
  - `Launcher` takes `opens`.
- a113605: Inboxes open as app windows instead of a page in the notifications drawer. Messages is one window that keeps running in the background: closing it hides it. Each Gmail account has one window, reused by its inbox row, its bar counter and its new-mail notifications. `Inbox.Page` is replaced by `Inbox.Window`, and an inbox's `launcherName` adds a launcher entry that opens its window.
- f18b865: Typing `!` in the launcher lists the site shortcuts (`!yt`, `!wiki`, `!p`, …) with what each does, narrowing as you type. Enter, Tab or a click fills one in.
- dc90c70: The launcher's inbox preview is centered at any height, shows up to eight newest unread emails, and marks an inbox with nothing unread with a check.
- 5bdc699: The launcher previews an inbox by its account, unread count and newest unread mail, instead of the command it runs.
- 6825067: The launcher is a quicker panel: the search box is its header (no "Open" title, no outline, a line under it), it is narrower (880px), matched letters are bold rather than teal, the picked row is a neutral highlight, and the footer is gone. Glass dialogs are near white in light mode. `Input` takes `flush`, `ModalDialog` takes `titleHidden`, and `ModalDialog`'s `lg` size is 880px.
- 7aa450b: Page Down and Page Up move the highlight a page in the launcher, clipboard history, file picker and app chooser. Ctrl+D and Ctrl+U move it half a page. `stepOf` in `list-walk` takes the page size, which `pageOf` measures from the list's scroller.

### Patch Changes

- a2def76: Rework the clipboard history to look and steer like the launcher: a search box that narrows the copies, one highlight for keyboard and pointer, readable rows with a text or link glyph, and the previous copy highlighted on open so Enter swaps back. The launcher's result rows move to the component library as `ResultList`, `RowTile` and `Marked`.
- e455955: `domicile open <file|folder|url>` opens anything: a web link in a browser window, anything else with its type's default from `mimeapps.list`, supertypes counted (a `text/plain` default opens Markdown and source code). `domicile open --app <url|module>` opens a site or app module as an app. Domicile's `xdg-open` and the launcher's Enter run it, so apps, terminals and the launcher agree. `open-url`, `open-app` and `run-app` are gone: use `open` and `open --app`.
- 670713c: The app chooser asks in plain words. With one application it asks "Open Claude?" beside Claude's icon ("Chromium wants to open this link in Claude."); with several, "Choose an app to open this link"; with none, "No app can open this link" and only Close. The link shows on one muted line at the bottom. `AppChooser` takes `asker`, `opened` and `address` in place of `title` and `description`.
- cd52ce3: The launcher's "Open with…" now lists first the app Enter opens the file with, so the two always agree. `domicile open --which <file|url>` prints the app `domicile open` would run, and the desktop puts its own `domicile` first on its apps' `PATH`.
- e7cbd52: The Open With dialog matches the other dialogs: launcher-style rows with a neutral wash on the picked app, 16px names, no ring around the list, and who asks in the footer. `LogoTile` in `RowTile` shows a logo in a row tile's place; the launcher uses it.
- 3146073: Each package asks for the bun and Node its workspace does: `engines` is `bun >=1.4.2`, `node >=24`.
- 2fe5852: Everything that took `system(domicile)` takes `desktop(domicile)`, or the namespace it calls.
  
  - SDK: `keyboard.keymaps` and `keyboard.selectKeymap`. `watchMenu`, `readIconTheme`, `watchIconTheme` and `previewFile` take `{ dbus }` or `{ files }`. `MenuSystem`, `IconThemeSystem` and `PreviewSystem` are `MenuDesktop`, `IconThemeDesktop` and `PreviewDesktop`.
  - system-apps: functions take `AppsDesktop` (`./apps-desktop`). `./fake-system`'s `fakeSystem` is `./fake-desktop`'s `fakeDesktop`.
  - component-library: `AppChooser`'s `system` prop is `domicile`; `PortalDialogs`' `systemOf` is `desktopOf`, and its `host` is a whole `DomicileHost`; `systemFolders` is `desktopFolders`, over `domicile.files`; `usePictureUrl` and `useApps` take `domicile.files` and `AppsDesktop`.
- 8b5c0ca: Widen the launcher back to the `xl` dialog size so the preview has room.
- Updated dependencies [bafd922]
- Updated dependencies [fe90bca]
- Updated dependencies [77fd631]
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
  - @domicile-desktop/manganese-host@2.0.0
  - @domicile-desktop/system-apps@1.1.0
  - @domicile-desktop/manganese-address@1.0.1

## 1.0.0

### Major Changes

- 2056529: The first release.

### Patch Changes

- Updated dependencies [2056529]
  - @domicile-desktop/component-library@1.0.0
  - @domicile-desktop/manganese-address@1.0.0
  - @domicile-desktop/manganese-host@1.0.0
  - @domicile-desktop/sdk@1.0.0
  - @domicile-desktop/system-apps@1.0.0
