# Electron apps

An installed Electron app runs on Domicile's engine instead of the Electron it
bundles. Its main process runs as an ordinary process with a stand-in
`electron` module, and its windows are app windows in the engine. The app
shares the desktop's browser, GPU and network processes, and its windows are
page elements like any other app window.

```
domicile open --electron claude-desktop.desktop [-- <its Exec>]
  ─▶ domicile       follows the entry's program, through wrapper scripts,
                    to the directory holding app.asar
       runs electron-host <resources> <the Exec's arguments>            bun
       exit 3: a page needs Node ─▶ a notification, then the Exec itself
  ─▶ electron-host  require("electron") = the stand-in
       runs package.json's main
       new BrowserWindow() ─▶ {"type":"create_window",…}                Electron socket
  ─▶ engine         an app window pinned to the app, its preload, its schemes
  ─▶ shell          DomicileBrowserWindow.isApp, plus its app menu
```

## Problem

- Every Electron app ships its own Chromium and runs its own browser, GPU,
  network and utility processes beside the desktop's.
- Its windows reach the desktop as Wayland surfaces, so they miss what page
  elements get: one layout, CSS, tabs.

## Design

### Running an app

- **`domicile open --electron <entry|path> [-- <command>…]`** takes a desktop
  entry id or a path into the install
  ([`electron_app.rs`](../../packages/domicile-launch/src/electron_app.rs)).
  The entry's program, or the command's when one is given, is followed
  through symlinks and through the paths each wrapper names until one is a
  directory holding `app.asar` or `app/`, or a program beside a `resources/`
  that does. Packages wrap Electron in scripts (`makeWrapper` on NixOS,
  shell scripts in `/usr/bin`), so the `Exec` rarely names it. On NixOS the
  wrapper is often compiled (`makeBinaryWrapper`, which wrapGAppsHook3 and
  wrapQtAppsHook use, as Claude's and ChatGPT's packages do); a compiled
  wrapper keeps the `makeCWrapper` command that made it, and the paths that
  command names are followed.
  What the wrappers set reaches the app: when the command is a bash script,
  it runs with `BASH_ENV` naming a script that replaces `exec`. Each script
  it execs runs the same way; the `exec` of the program execs `domicile`
  instead, which records the command line and the environment it got and
  exits. A compiled wrapper is followed by running its `makeCWrapper`
  command as bash, which sets what the wrapper sets, adds its flags and
  execs the same way. The app gets that
  environment (`LD_PRELOAD`, `PATH`) and those arguments, less the app's own
  path a generic Electron is given, as its `process.argv`
  ([`electron_wrapper.rs`](../../packages/domicile-launch/src/electron_wrapper.rs)).
  A command that is neither a bash script nor a compiled wrapper, or that never reaches the app's program
  within 10 seconds, gives its arguments alone, and the latter is logged.
- **`electron.apps`** in the desk config lists desktop entry ids. The
  compositor copies each entry into a directory first on the desk's
  `XDG_DATA_DIRS`, with every `Exec` running
  `domicile open --electron <id> -- <the original Exec>`, and without
  `DBusActivatable` and `TryExec`
  ([`electron_entries.rs`](../../packages/domicile-host/src/electron_entries.rs)).
  So whatever starts the entry by its id runs it on the engine: any shell's
  launcher, a `slack://` link through `domicile open` or GIO, a press on a
  notification. No shell needs to know. The copies are written at start and
  again when a reload changes the list. An entry in the data home
  (`~/.local/share/applications`) comes before every data directory, so it
  can't be overridden; that is logged as an error. The app's own package
  installs and updates it; nothing is repackaged.
- **`domicile` runs `electron-host`** (`libexec/domicile/electron-host`, or
  `DOMICILE_ELECTRON_HOST`) and waits on it, in the place of whatever started
  it: the compositor, for an app the launcher starts. So the app outlives a
  shell reload, as any client does.

### The main process: `electron-host`

A bun workspace package, `packages/electron-host`, run by Bun.

- Mirrors the install's `resources/` into
  `$XDG_CACHE_HOME/domicile/electron/<key>/`: every `*.asar` extracted to a
  directory of the same name, everything else a symlink. The key is the
  archives' paths, sizes and times, so an update makes a new mirror.
- Runs `package.json`'s `main` from the mirror.
- A module hook answers `require("electron")` with the stand-in, which
  implements Electron's main-process API over the Electron socket.
- Sets `process.type`, `process.versions.electron`, `process.resourcesPath`
  and `app.getPath()` as Electron does. `userData` is the app's existing
  directory (`~/.config/Claude`), so logins and settings carry over.
- An exception or rejection nothing catches is logged as an error, and the
  app runs on, as on Electron. Bun alone would exit. An app's own
  `uncaughtException` or `unhandledRejection` handler takes it instead.
- Native modules load as they are. N-API is runtime-independent, and every
  native module in the apps inspected (below) is N-API.
- `utilityProcess.fork()` is a child process of the same runtime. Its module
  gets `process.parentPort`, and `MessageChannelMain` ports sent with a
  message carry structured clones over the child's IPC channel. Messages
  wait until the module has loaded, so one sent right after `fork` is not
  lost. The child lives until it exits or the app kills it, and goes with the
  host. Its `require("electron")` is not answered yet.
- **Quirks table:** per-app overrides inside the package, keyed by the
  app's `package.json` name
  ([`quirks.ts`](../../packages/electron-host/src/quirks.ts)). Today it names
  the apps that need their own Electron: the phase-2 apps inspected (below),
  and ChatGPT, which refuses to start on anything but OpenAI's Electron fork,
  Owl. Node instead of Bun and an updater to skip go there when an app needs
  them.

Bun over Node because the desktop already ships Bun for the builder. Node is
the fallback for an app Bun can't run, and becomes required in phase 2.

### The Electron socket

`--domicile-electron-socket <path>` makes the engine bind a Unix socket that
each `electron-host` keeps open for the app's life. The desktop passes it and
names it to apps in `DOMICILE_ELECTRON_SOCK`.

- Each line is one JSON object, both ways
  ([`electron_protocol.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_protocol.h)).
  Protocol bodies travel as base64.
- One connection is one app. Closing it closes the app's windows.
- A request the engine needs answered (a protocol request, `sendSync`)
  carries an id; the host replies with that id.

### Windows

- **`new BrowserWindow()`** asks for an app window pinned to the app, as
  `open --app` does ([WEB-APPS.md](WEB-APPS.md)).
- **`WebContentsView`** and **`BrowserView`** are views: pages that are part
  of a window, not windows. Claude Desktop's whole chat is one, under its
  title bar page.
  - The host opens one with `open_window` and `"view": true`, and places a
    window's views with `set_views {window, views: [{window, x, y, width,
    height, hidden?}]}`, bottom first, replacing the ones it held. Only a
    window holds views, and only views are held. A view placed in another
    window moves there.
  - The engine lists a view to the shell only while a window holds it, right
    after that window, with `parent` and the app's bounds
    (`DomicileBrowserWindow.parent`, `x`, `y`, `width`, `height`,
    `isHidden`). It is never a capture source of its own: a screenshot or
    screen cast of its window draws it over the window's page where the app
    placed it ([PORTALS.md](../PORTALS.md)).
  - **The shell lays views out.** The app's bounds are what it asks for:
    Manganese draws each view there, over its window, and another shell may
    put views in tabs or a split instead (user's decision, 2026-11-14).
  - The engine tells the app each page's size, its windows' and its views',
    with `resized {window, width, height}`, for `getContentBounds()`,
    `getBounds()` and the `resize` event.
  - A view outlives the window that held it until the app closes it, as an
    Electron app's do.
  - In the host, `win.contentView.addChildView(view, index?)`,
    `removeChildView`, `view.setBounds` and `view.setVisible` each send the
    window's `set_views`, only once the window and the view have opened and
    only when something moved. `BrowserView` is a view placed with
    `setBrowserView` and kin; its `setAutoResize` follows the window's
    `resized`. A view nested in a view throws, since only a window holds
    views. `BrowserWindow.fromWebContents` finds the window holding a view's
    page.
- **`loadURL`, `loadFile`, title, show, focus and close** map to existing
  window requests.
  - **Title:** a window has its own title, which the desktop shows (the
    shell's tab, capture tools) over its page's: `title` with `open_window`,
    then `set_title {window, title}` on `setTitle` and on each page title the
    app's `page-title-updated` listeners let through. An app that prevents
    them, as Claude Desktop does, keeps its own.
  - **Close:** the user closing a window doesn't close it. The engine says
    `close_asked {window}`, and the host emits the window's `close` event;
    only if no listener prevents it does the host ask with `close_window`.
    An app that closes to its tray, as Slack and Element do, prevents it and
    hides the window.
  - **Page state:** the engine sends `page_state {window, entries, index,
    loading, focused, pid, crashed, process_id, routing_id, frame_token,
    waiting}` whenever any of it changes
    (`ElectronPage::ReportState`). The host answers `navigationHistory` (and
    `canGoBack` and the rest), `isLoading`, `isFocused`, `isCrashed`,
    `getOSProcessId`, `getProcessId`, `isWaitingForResponse`, the main
    frame's ids, `BrowserWindow.getFocusedWindow` and
    `webContents.getFocusedWebContents` from it, and emits
    `did-start-loading`, `did-stop-loading`, `focus`, `blur` and
    `render-process-gone`. `goBack`, `goForward` and `goToIndex` send
    `go_to_index {window, index}` for an index the history has;
    `navigationHistory.clear` sends `clear_history {window}` and
    `removeEntryAtIndex` sends `remove_history_entry {window, index}` for an
    entry the page doesn't show. `restore` opens a page that hasn't loaded
    with `open_window`'s `history {entries, index}`
    (`WebViewGuest::RestoreHistory`), as Electron restores only into a page
    with no history. A window is focused when its page has the keyboard
    focus.
  - **Navigations:** `ElectronPage` tells the app of each navigation in the
    shown page's frames, with the frame's `{process, routing}` ids:
    `navigation_started`, `navigation_redirected`, `navigation_committed`,
    `load_failed`, `frame_loaded` and `frame_created`. The host emits
    Electron's `did-start-navigation`, `did-redirect-navigation`,
    `did-navigate`, `did-frame-navigate`, `did-navigate-in-page`,
    `did-fail-provisional-load`, `did-fail-load`, `did-frame-finish-load`
    and `frame-created`, with Electron's details and older arguments
    ([`navigation.ts`](../../packages/electron-host/src/electron/navigation.ts)).
    A main-frame `did-fail-load` rejects the `loadURL` under way with
    Electron's error. `mainFrame` takes the engine's ids; another frame is a
    `SubFrame` that names itself and its address and throws on scripts and
    IPC, as the engine runs those only in the main frame.
  - **Will navigate:** a navigation the page starts itself, and each server
    redirect, waits for the app (`AppNavigationThrottle`, `will_navigate`,
    answered by `navigation_answer`). The host emits `will-redirect`, or
    `will-frame-navigate` and then, for the main frame, `will-navigate`; a
    listener's `preventDefault` cancels it. Slack, Element and Claude Desktop
    keep plain links out of their windows this way and open them with
    `shell.openExternal`. The app's own `loadURL`, a history step and a
    reload ask nothing, as in Electron. Only a window whose webContents has
    one of those listeners waits: the host says so as listeners come and go
    (`navigation_listen`), and otherwise the engine lets the navigation go
    at once, without a round trip.
  - **Unload:** a `beforeunload` that asks to stay asks the app, not the
    shell (`will_prevent_unload`, answered by `unload_answer`), and shows no
    dialog. The page leaves only if a `will-prevent-unload` listener prevents
    it, as in Electron.
  - **Edit and find:** `webContents.undo`, `redo`, `cut`, `copy`, `paste`,
    `pasteAndMatchStyle`, `delete`, `selectAll`, `unselect` and
    `centerSelection` send `edit {window, command}`, which the engine does
    at the page's focus (`ElectronPage::Edit`); `replace` and
    `replaceMisspelling` send `replace {window, text, misspelling}`. The
    Edit menu's roles call them on the window clicked. `findInPage` numbers
    each search from 1 and sends `find_in_page {window, request, text,
    forward, find_next, match_case}`; the engine answers a search once, when
    Chromium's last reply for it comes, with `found_in_page {window,
    request, matches, active_match_ordinal, selection}`, which the host
    emits as `found-in-page`. `stopFindInPage` sends `stop_find_in_page
    {window, action}`.
  - **Context menus:** a right click in a window's or view's page goes to
    its app, not the shell, as Electron draws no menu of its own. The
    engine sends `context_menu {window, x, y, link_url, …, edit_flags,
    media_flags}` (`WebViewGuest::TakeContextMenusWith`), which the host
    emits as webContents `context-menu` with Electron's params; the app
    draws its menu with `Menu.popup`, or none.
  - **Hide and show:** `hide()`, `show()`, `showInactive()` and `show:
    false` send `set_hidden {window, hidden}` (`hidden` with `open_window`).
    A hidden window stays open, its page running; the engine lists it with
    `isHidden`, which tells the shell to keep it out of sight, and leaves it
    out of capture tools' lists. `show()` also focuses it. Manganese takes a
    hidden window off its workspace and puts it on the one on screen when it
    is shown.
  - **Window state:** `maximize()`, `unmaximize()`, `minimize()`,
    `restore()`, `setFullScreen()` and `fullscreen: true` send
    `set_window_state {window, maximized, minimized, fullscreen}`, what the
    app asks, once the window is open. The engine lists it as the window's
    `wantsMaximized`, `wantsMinimized` and `wantsFullscreen`; the shell
    decides, and reports what it made the window with
    `setBrowserWindowState`, which reaches the app as `window_state` only when
    it changes. `isMaximized`, `isMinimized`, `isFullScreen` and `isNormal`
    read the shell's last report, and the host emits `maximize`,
    `unmaximize`, `minimize`, `restore`, `enter-full-screen` and
    `leave-full-screen` as it changes. The app's next ask starts from that
    report, so a window the user took out of fullscreen stays out when the
    app maximizes it. `setFullScreen` does nothing for a window made with
    `fullscreenable: false`. Manganese fills the screen with a window whose
    app asks for fullscreen, as for a fullscreen page, and reports it; its
    windows tile, so none is maximized or minimized
    (`browser/useAppWindowState.ts`).
  - **Icon:** an Electron window is listed with its app's desktop id
    (`appId`), and Manganese draws the app's icon from its desktop entry for
    it, in its title bar and in the screenshot and screen cast pickers, over
    the page's icon. Window size and position are not the app's to set: the
  shell lays out windows. A window's size reads as the shell gave it
  (`getContentBounds`, `getBounds`, `getSize`), and `resize` fires as it
  changes; before the shell gives one, it is the size the app asked for.
- **`loadFile`** loads from the mirror, so the engine reads plain files.
- **Storage:** each app gets its own partition, named by its `package.json`
  name. Apps share no cookies with each other or with the browser.
- **New windows:** a page's `window.open`, `target="_blank"` link or
  middle click asks the app's `setWindowOpenHandler` before any window opens
  (`window_open`, answered by `window_open_answer`). Slack and Claude
  Desktop deny theirs and pass the link to `shell.openExternal`, which opens
  it in the desktop's browser, in the profile its site opens in, with the
  user's sign-ins. An allowed window, or any with no handler, as in
  Electron, is a new `BrowserWindow` of the app, from the opener's
  `webPreferences`, the size `window.open` asked for and the handler's
  `overrideBrowserWindowOptions`; `did-create-window` fires, and
  `createWindow` may make it instead.
  - A noopener window (and a middle click) is taken before content makes
    one (patch 0239, `BrowserPluginGuestDelegate::TakeNoopenerWindow`), and
    an allowed one opens where the page asked.
  - A window its opener keeps a handle on, such as a sign-in popup, is
    held while the app decides: destroyed if denied, adopted as the app's
    window if allowed (`ElectronDesk::Adopt`), in the opener's session.
    Content has started its first navigation by then, so its preload and
    its session's user agent apply from its next document.
- **What a page reports** reaches its `webContents`
  ([`electron_page_reports.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_page_reports.h),
  `ElectronPageEvents` in
  [`domicile_electron_page_events.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_page_events.h),
  `page-events.ts` in the host):
  - `console-message`, `preload-error`, `media-started-playing`,
    `media-paused`, `audio-state-changed` (and `isCurrentlyAudible`),
    `page-favicon-updated`, `update-target-url`, `zoom-changed`,
    `did-change-theme-color`, `cursor-changed`, `preferred-size-changed`
    (with `webPreferences.enablePreferredSizeMode`) and
    `content-bounds-updated`, whose window the desktop still places.
  - `unresponsive`, `responsive`, `enter-html-full-screen` and
    `leave-html-full-screen` on its `BrowserWindow` too.
  - A Ctrl+wheel the page leaves is `zoom-changed` for the app, and the
    shell zooms nothing, as in Electron.
- **Input:** while the app listens for `before-input-event`, each key-down
  and key-up waits in its widget for the app's answer (`before_input`,
  `input_answer`), after the desktop's chords, which never reach the app.
  A prevented key-down takes its characters with it (patch 0267,
  `WebContentsDelegate::DomicileHoldKeyboardEvent`). `before-mouse-event`
  holds the main frame's mouse events the same way, and `input-event`
  hears what reached the page. `sendInputEvent` sends a key, mouse event
  or wheel to the main frame; a key it sends reaches the page only, not
  the desktop's chords or the menu bar.
- **A page's own settings:** `setAudioMuted`, `setUserAgent` (over its
  session's, from the first load when set before it), and
  `setIgnoreMenuShortcuts`, which keeps every unhandled key from the shell:
  the menu bar's accelerators and the shell's page-first bindings alike.

### Page calls

The host carries out the webContents members that act on the page with
`page_call {window, call, method, ...}`, numbered by the app and answered
`page_result {window, call, result | error}`
([`electron_page_call.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_page_call.h),
[`page-control.ts`](../../packages/electron-host/src/electron/page-control.ts)).

| Electron | `method` |
|---|---|
| `reloadIgnoringCache` | `reload_ignoring_cache` |
| `insertCSS`, `removeInsertedCSS` | `insert_css`, `remove_inserted_css`, in the main frame's document |
| `executeJavaScriptInIsolatedWorld` | `execute_in_isolated_world`: world 0 is the page's, 999 the preload's |
| `copyImageAt`, `copyVideoFrameAt`, `adjustSelection` | `copy_image_at`, `copy_video_frame_at`, `adjust_selection` |
| `caretBrowsingEnabled`, `setWebRTCIPHandlingPolicy` | `set_caret_browsing`, `set_webrtc_ip_policy` (renderer prefs) |
| `win.setEnabled`, a modal's parent | `set_ignore_input` |
| `capturePage`, `printToPDF`, `enableDeviceEmulation`, `beginFrameSubscription`, the session's `enableNetworkEmulation` | `devtools`: `Page.captureScreenshot` (with `Page.getLayoutMetrics` for a rect), `Page.printToPDF`, `Emulation.setDeviceMetricsOverride`, `Page.startScreencast`, `Network.emulateNetworkConditions` |

- **DevTools:** each page has one DevTools client, untrusted and with no
  local files, attached at its first `devtools` call and kept while the page
  lives, as an emulation or a screencast lasts only while its client does.
  It takes only the methods in the table, and its events come as
  `devtools_event {window, method, params}`.
- **Settings** (caret browsing, the WebRTC policy, ignoring input) set
  before the page opens wait for it; the other calls reject. The engine
  puts caret browsing and the WebRTC policy back before each document, over
  the renderer prefs Chrome makes from the profile's. A profile pref that
  changes while a document shows can reset them until the next one.
- **Captures** of a page that doesn't show (a hidden window, or a view no
  showing window holds) are empty, as such a page draws no frame.
- **Not yet:** `print` (Chrome says nothing when its dialog is done),
  `savePage` (a download), `clone`, and `getMediaSourceId`, which no
  capture source in the engine answers to.

### Preload and IPC

- **Preload:** the engine runs the window's preload in an isolated world
  before the page's own scripts, with a sandboxed Electron page's `electron`
  module bound in: `contextBridge`, `ipcRenderer`, `webFrame` (the main
  frame, its own `top`, with `frameToken`, `insertCSS`, `insertText`, the
  zoom and pinch zoom's limits), `crashReporter`, and `webUtils` and `nativeImage`, whose calls
  say they don't work yet. Its `process` has `isMainFrame`, `contextId`, and
  `versions.electron` and `resourcesPath` from the app's `hello`; Electron's
  own calls on it, such as `getCPUUsage`, say they don't work yet. Its
  `process` is an EventEmitter, as Electron's is: it says `loaded` and
  `document-start` once the preload has run, and `document-end` once the
  document's `DOMContentLoaded` has been dispatched. Slack's preload sets up
  its window on `document-start`, and without `process.on` it throws before
  exposing anything, so Slack never signs in. It doesn't say `exit`. Its
  `process.argv` ends with the window's
  `additionalArguments`, which the host sends as `open_window`'s
  `arguments`; Claude's preloads read their features there. The preload has
  no `require` beyond `electron`.
  The host sends the preload's source with `open_window`; the browser hands
  it to the window's main frame before each navigation commits, and the
  renderer runs it at document start, ahead of extensions' content scripts
  ([`electron_preload.h`](../../packages/domicile-engine/src/components/domicile/renderer/electron_preload.h)).
- **Node in the page:** a window that isn't sandboxed (`sandbox: false`, or
  `nodeIntegration` without `sandbox: true`, as Electron decides) has Node.js
  in its page instead. The host sends `node` with `open_window` in place of
  the preload's source: the preload's file, `nodeIntegration`,
  `contextIsolation`, the app's paths and environment. The browser learns
  which renderer the page's navigation goes to before it starts
  (`ContentBrowserClient::MainFrameNavigatesInto`, patch 0236) and starts it
  unsandboxed and outside the zygote, for that page alone, as Electron does
  ([`domicile_electron_page.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_page.h)).
  There the renderer starts Electron's Node on its own V8, a Node environment
  in the preload's world (the page's own without context isolation), with
  libuv's loop run in turns off the renderer's, and loads the preload with
  Node's `require`, `require("electron")` giving the same `contextBridge` and
  `ipcRenderer`
  ([`electron_node.h`](../../packages/domicile-engine/src/components/domicile/renderer/electron_node.h)).
  With `nodeIntegration` and no context isolation the page gets `require`,
  `module`, `__filename` and `__dirname`; without either, Node's globals
  leave the page's world once the preload ran. A preload's `require` of a
  native module needs the engine to export Node's symbols, which it doesn't
  yet.
- **`contextBridge.exposeInMainWorld`** copies the API into the page:
  objects, arrays, dates, errors and bytes are copied, functions and promises
  are wrapped so they run and settle in their own world
  ([`context_bridge.h`](../../packages/domicile-engine/src/components/domicile/renderer/context_bridge.h)).
- **IPC** runs page ─▶ engine ─▶ Electron socket ─▶ host and back: `send`,
  `invoke`/`handle`, `postMessage` with ports, and `sendSync`. `sendSync`
  blocks only the calling page, on a sync Mojo call that the browser process
  answers when the host replies. Arguments travel as JSON, not structured
  clones, so a `Map` or bytes do not survive the trip.
- **Message ports:** each port the main process holds an end of is a relay.
  The preload's world keeps the page-side end of a pipe and forwards what
  arrives on it over the socket as `port_message`; the host's `port_post`
  goes the other way. A port's name says who made it (`m1` by the main
  process, `r1` by the page), and `page_gone` tells the host that a new
  document took the old one's ports.

### Requests

- **Sessions** are partitions inside the app's own: `session.fromPartition`
  and `webPreferences.partition` name one, `persist:` keeps it on disk as in
  Electron, and none reaches another app's storage or the profile's.
  `open_window` names the window's session.
- **`protocol.handle`** (and the older `register*Protocol`) sends a session's
  requests for a scheme to the app: `handle_protocol` names the session and
  scheme, the engine sends each request as `protocol_request`, and the app
  answers with a whole body, a file the engine reads, or a stream of pieces
  ([`electron_app.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_app.h),
  [`domicile_electron_loader.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_loader.h)).
  A window opens a URL in a scheme its session handles; content keeps other
  schemes out of guests.
- **`loadFile`** is a `file:` URL that the host's own `file:` handler serves,
  from the mirror, as Electron would serve it. The engine's file loader never
  serves an Electron page: what `file:` reads is the app's to decide.
- **`http` and `https`** go to the network unless the session handles them;
  the app then answers before anything else sees the request, as in Electron.
- **`intercept*Protocol`** puts a handler ahead of the scheme's own, or of
  the network for `http` and `https`, until `uninterceptProtocol`.
- **`protocol.registerSource`** serves a scheme from directories without the
  app's code: the host picks the route and file, and the engine reads it as
  a `file:` URL's.
- **`session.fromPath`** is the persistent session named by its path
  (`persist:<path>`); the engine keeps its storage in the app's profile.
- **An app's own schemes** (`app://`, `cowork-artifact://`) are registered
  when the engine starts, because Chromium registers schemes only as each
  process starts. `ready` names the schemes the engine registered and the
  privileges it granted each. When an app's `registerSchemesAsPrivileged`
  names one the engine lacks, or a granted privilege it lacks, the host adds
  it to `$XDG_STATE_HOME/domicile/electron-schemes.json` (each app's package
  name, then its schemes and privileges) and exits 3, so the app runs on its
  own Electron this time
  ([`schemes.ts`](../../packages/electron-host/src/electron/schemes.ts)).
  At each engine start the supervisor passes every kept scheme as
  `--domicile-electron-schemes=app:standard,secure;…`, with Electron's names
  for the privileges, two apps' copies of a scheme getting what either asked
  for ([`electron_schemes.rs`](../../packages/domicile-launch/src/electron_schemes.rs)).
  The browser hands the switch to every child process. `standard`,
  `secure`, `bypassCSP`, `corsEnabled` and `supportFetchAPI` are granted;
  `stream`, `codeCache` and `allowServiceWorkers` are not yet, and don't
  hold an app back. A scheme the engine keeps for itself is refused without
  being kept ([`electron_schemes.h`](../../packages/domicile-engine/src/components/domicile/common/electron_schemes.h)).
  Local Network Access classes a page in one as loopback, as it does the
  shell: the app is installed on this machine, not a site. Left public, every
  request into the LAN or a VPN (Element's homeserver) asked a permission no
  one answers (patch 0238).
  An app's first run with a new scheme falls back. Known apps' schemes, as
  their own runs recorded them, register from the first start (`KNOWN` in
  `packages/domicile-launch/src/electron_schemes.rs`) to spare them that.
- **Not yet:** a handler's redirect (the load fails loudly), a request body
  that is a file or a stream, and requests from an Electron page's workers,
  which go to the network.
- **`session.webRequest`**: `web_request_listen` names the events a
  session has listeners for. Each of its pages' network requests then meets
  them in Electron's order. `onBeforeRequest` may cancel or redirect,
  `onBeforeSendHeaders` may replace the request's headers, and
  `onHeadersReceived` may cancel or replace the response's headers and
  status line; a document's CSP and Permissions-Policy follow the new
  headers. The request waits for each of those three
  (`web_request_answer`). `onSendHeaders`, `onResponseStarted`,
  `onBeforeRedirect`, `onCompleted` and `onErrorOccurred` only tell the app
  ([`domicile_electron_web_request.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_web_request.h)).
  An answer that changes what its event cannot, or an app that goes while a
  request waits, cancels the request. Not yet: the headers the network
  service adds (cookies among them) are not in `requestHeaders`, a
  redirect `onHeadersReceived` writes is not followed, a redirect to a
  scheme the web cannot reach is refused, and WebSockets and workers' requests
  pass by the listeners.
- **Session calls** (`session_call`, answered by `session_result` under
  the same `call`): `cookies.get`, `set`, `remove` and `flushStore`,
  `clearStorageData`, `clearCache` and `setUserAgent`, each on one of the
  app's sessions and so on its partition only. `cookies.get` gives every
  cookie a request to its `url` could carry, HTTP-only and cross-site ones
  included, as Electron does. A session's user agent reaches its open
  windows from their next navigation and its new windows before their first
  ([`domicile_electron_storage.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_storage.h)).
  The first `cookies.on('changed')` listener sends `cookies_watch`; from
  then on each change to the session's cookies comes back as
  `cookie_changed`, with Electron's `cause` and `removed`. Slack waits on it
  to finish signing in.
- **User agent**: `ready` names the engine's user agent and Chrome's full
  version. The host makes Electron's from them (`Name/1.2.3 Chrome/<full>
  Electron/<version>` in Chrome's place) and sends it as
  `set_user_agent_fallback`, `app.userAgentFallback`, before the app's
  windows open. A session without its own user agent has it.
- **Permission handlers** (`permission_handler`): while one of the app's
  sessions has a `setPermissionRequestHandler`, its pages' permission
  requests ask the app (`permission_request`, answered by
  `permission_answer` under the same `ask`) instead of the shell, with
  Electron's names: `media` (its `mediaTypes`), `geolocation`,
  `notifications`, `clipboard-read`, `midiSysex`, `window-management`,
  `idle-detection`, and `unknown` for local fonts. Chrome keeps the answer
  for the origin as it keeps a user's, so the handler is asked when Chrome
  would prompt, not on every request as in Electron. A request Electron has
  no name for (several downloads at once) still asks the shell, as every
  request does in a session with no handler, where Electron would grant it.
  An app that goes while a request waits denies it
  ([`domicile_permissions.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_permissions.h)).
  Not yet: `setPermissionCheckHandler`, which Electron calls synchronously;
  checks answer from what Chrome kept.
- **Downloads** go where the session's `will-download` says. The engine
  marks each download an app's page starts as the app's, so it reaches the
  app after its page closes (Slack downloads from a hidden window it closes at
  once). Before any picker, it sends `will_download {download, session,
  window?, url, url_chain, filename, ...}`; the host emits `will-download`
  with a `DownloadItem` and answers `download_answer {download, path?,
  cancel?}`: the save path the app set, a cancel for `preventDefault` or
  `cancel()`, or neither, and the shell's picker asks, as Electron's save
  dialog does. Then `download_updated` says how it goes, which the item emits
  as `updated` and, once done, `done`; `pause`, `resume` and `cancel` go back
  as `download_control`. An app that goes first cancels the downloads it
  never answered
  ([`electron_downloads.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_downloads.h),
  `src/electron/downloads.ts`). Not yet: `session.downloadURL`,
  `webContents.downloadURL`, `setDownloadPath`, `createInterruptedDownload`.
- **Sign-ins and certificates**: a page's HTTP or proxy sign-in asks its
  app as `login` (answered by `login_answer`: `sign_in` with a user name and
  password, `cancel`, or `default` when no listener took it, and then the
  shell's prompt asks the user, where Electron would cancel). A certificate
  error asks as `certificate_error`, every frame's, with Electron's
  `Certificate` and its issuer's (`certificate_answer`; no listener denies
  it, as in Electron). A site's request for a client certificate asks as
  `select_client_certificate`, with the ones the system has
  (`client_certificate_answer` names the one chosen by index; no listener
  takes the first, and none offered goes on with none at once). Each ask is
  numbered per app, and an app that goes cancels its sign-ins, refuses its
  certificates and chooses no certificate
  ([`electron_sign_ins.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_sign_ins.h),
  [`domicile_electron_certificates.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_certificates.h)).
  A `ClientRequest`'s `login` is the host's own: a 401 its listeners answer
  is sent again with Basic credentials.
- **The session's network and storage** (more session calls):
  `clearData` (Electron's data types, origins to clear or to keep, cookies
  by their sites), `clearAuthCache`, `clearCodeCaches`, `resolveHost`,
  `preconnect`, the shared dictionary calls, and `storage_path`, which the
  host asks for each session as it is made so `getStoragePath()` and
  `storagePath` answer at once (`null` in memory). The first use of
  `session.serviceWorkers` sends `service_workers_watch`, answered by the
  workers running then; from then on each start, stop, registration and
  console message comes back as `service_worker`
  ([`electron_network_calls.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_network_calls.h),
  [`domicile_electron_network.h`](../../packages/domicile-engine/src/chrome/browser/domicile/domicile_electron_network.h)).
  A session's own preloads (`registerPreloadScript` with type `frame`, and
  `setPreloads`) run before the window's in a sandboxed page, each in turn,
  one's error thrown apart so the next still runs; a Node page refuses
  them for now. `setCodeCachePath` is `set_code_cache_path`: the partition
  keeps the code V8 compiles from then on in the app's directory
  ([`domicile_code_cache.h`](../../packages/domicile-engine/src/content/public/browser/domicile_code_cache.h)).
- **Session events**: a page's resource hint (`<link rel=preconnect>`)
  comes as `preconnect {session, url, allow_credentials}`, its session's
  `preconnect`. Each dictionary the engine checks spelling with comes as
  `spellcheck_dictionary_initialized {language}` once loaded, those loaded
  already right after `ready`; the app's sessions are partitions of the
  shell's profile, so every session fires it, from `ready` on. The
  dictionaries ship beside the engine, so no `spellcheck-dictionary-download-*`
  comes. `gpu_info_update` is app's `gpu-info-update`
  ([`electron_session_events.h`](../../packages/domicile-engine/src/components/domicile/browser/electron_session_events.h)).
- **Network emulation**: `enableNetworkEmulation` is
  `Network.emulateNetworkConditions` on the DevTools client of each of the
  session's pages ([Page calls](#page-calls)), and of each it opens later
  (`src/electron/network-emulation.ts`). A session's service workers are
  not throttled.
- **`WebSocket`** (and `net.WebSocket`) is Bun's, with Electron's options:
  the handshake's headers and origin and, with `useSessionCookies`, the
  session's cookies (`src/electron/web-socket.ts`). Cookies the handshake's
  answer sets are not kept.
- **Not yet:** `setSSLConfig` (the profile's SSL settings reach each
  partition's network), extensions (they belong to a Chrome profile, and an
  app's sessions are partitions of the shell's, which holds the user's own:
  one an app loaded would reach the user's browsing), the device choosers'
  `select-hid-device`, `select-serial-port` and `select-usb-device` (the
  shell's chooser answers), `file-system-access-restricted`, a utility
  process's `login`, `setClientCertRequestPasswordHandler`, a service
  worker's `ServiceWorkerMain` and IPC, `registerLocalAIHandler` and
  `sharedTexture`.

### Desktop pieces

| Electron | Domicile |
|---|---|
| `Menu.setApplicationMenu`, `win.setMenu` | a menu bar under the window's tab, drawn by the shell. The host (`src/electron/browser-window.ts`) sends each window's menu model with `set_menu_bar` once the window opens and again whenever the menu changes, and runs the entry a `menu_clicked` names for that window. As on Electron for Linux, `setApplicationMenu` sets every window's menu and each new window starts with it; `autoHideMenuBar`, `setAutoHideMenuBar`, `setMenuBarVisibility` and `removeMenu` go along with it. Electron's default menu isn't made: an app with no menu has no bar |
| `Menu.popup`, `Menu.closePopup` | a menu the shell draws over the window, with the menu bar's entries and look. The host sends the menu's model with `popup_menu`, at the app's `x` and `y` or, without them, where the user last pressed in the page (a menu button's click). The entry chosen runs as a menu bar click does, then `menu-will-close` and the `callback`. One popup at a time per window: a new one replaces the last, which closes with nothing chosen, as does one whose window closes. `positioningItem`, `sourceType` and `frame` are other platforms' and are not used |
| `Menu`, `MenuItem` | built in the host (`src/electron/menu.ts`): roles get Electron's Linux labels and accelerators, and role menus (`editMenu`, `viewMenu`, …) expand as Electron's do; macOS-only roles are hidden. The tray and the menu bar draw a menu's model and click its entries by number; a click toggles a checkbox or picks a radio first. The Edit menu's roles act on the clicked window's page. A role the host doesn't carry out yet throws when clicked, naming it. `before`/`after` place items; group positions keep template order |
| `Tray` | a StatusNotifierItem on D-Bus, as Electron does on Linux ([SYSTEM-TRAY.md](SYSTEM-TRAY.md)), built in the host (`src/electron/tray.ts`). Each tray has its own bus connection, so `destroy` takes the icon down. The icon goes as `IconPixmap`, the tooltip as `ToolTip`'s title, and the context menu as a `com.canonical.dbusmenu` at `/MenuBar` that the shell draws and clicks; a change anywhere in the menu sends `LayoutUpdated`. `Activate` is `click`, `SecondaryActivate` `middle-click` and `ContextMenu` `right-click`. The click's activation token isn't needed: the engine raises the app's windows itself. Balloons, pressed images, `setTitle` and `getBounds` are other platforms' and do nothing |
| `Notification` | `org.freedesktop.Notifications`, as Electron does on Linux ([NOTIFICATIONS.md](NOTIFICATIONS.md)): a click is the `default` action, buttons are actions numbered from 0, `hasReply` is `inline-reply`, labeled with `replyPlaceholder` or else "Reply", and `desktop-entry` names the app. An icon is a file path; a `nativeImage` icon throws until the host has `nativeImage`. `sound` is the `sound-file` hint for a path, else `sound-name`; `closeButtonText` is kept, as the desktop's notifications have no close button text |
| `dialog` | file dialogs through the file chooser portal ([PORTALS.md](/docs/PORTALS.md)), built in the host (`src/electron/dialog.ts`): Electron's properties, filters, button label and default path become the portal's options, and its URIs come back as paths. The `Sync` calls block on a child process that asks the portal (`src/choose-file.ts`), as Electron's block the main process. Dialogs aren't tied to the app's window yet: Electron windows are the shell's pages, not toplevels a portal can name. `showMessageBox` sends `show_message_box` over the window the app names, or its most recent open one, and resolves with the `message_box_answered` the shell's answer brings (`src/electron/message-boxes.ts`); with no window open it rejects. As Electron, no buttons is one OK, and the cancel button the app names none for is the first labeled Cancel or No. `showMessageBoxSync` throws, as nothing can block for the shell's answer; `showErrorBox` writes to the host's log |
| `nativeTheme` | the settings portal's `org.freedesktop.appearance` `color-scheme` and `contrast`, read before the app's main runs and followed after; the app's `themeSource` overrides `shouldUseDarkColors` |
| `shell.openExternal`, `openPath`, `showItemInFolder` | `domicile open` (the item's folder for `showItemInFolder`) |
| `shell.trashItem` | the freedesktop.org trash, as file managers keep it (`src/electron/trash.ts`): `$XDG_DATA_HOME/Trash` for an item on its device, else the trash at the top of the item's own device, with each item's `.trashinfo` |
| `shell.beep` | the compositor's `xdg_system_bell_v1`, rung for no window, as Electron's beep names none; the shell decides how a bell sounds (`src/wayland-bell.ts`) |
| `safeStorage` | Chromium's OSCrypt for Linux, byte for byte, built in the host (`src/electron/safe-storage.ts`), so what an app encrypted on its own Electron decrypts here and back: AES-128-CBC with the PBKDF2 key of a password the Secret Service keeps as "Chromium Safe Storage" with `application` set to the app's name (`src/secret-service.ts`), prefixed `v11`. The async calls answer the same; `decryptStringAsync`'s `shouldReEncrypt` is true for `v10` text once the keyring has a key. The password is read, or created, when the app first needs it, blocking on a child process (`src/safe-storage-password.ts`) as Electron blocks on libsecret, so a locked keyring asks to be unlocked then, both to read the password and to create it. The backend is chosen as Chromium chooses it, so an app finds its store where its own Electron left it: `--password-store` first (`basic` is `basic_text`; `gnome`, `gnome-keyring` and `gnome-libsecret` are the Secret Service; KWallet hands the app back), then `XDG_CURRENT_DESKTOP` (GNOME, Cinnamon, Pantheon, XFCE, Unity, Deepin and UKUI use the Secret Service; KDE hands the app back; any other desktop, Domicile included, is `basic_text`, as on Chromium). On `basic_text` the keyring is never read. With no Secret Service, an unlock refused, or a Secret Service that fails (said on stderr), the backend is `basic_text` too: encryption needs `setUsePlainTextEncryption(true)` and uses the hardcoded `v10` key, as in Electron |
| `desktopCapturer`, `setDisplayMediaRequestHandler` | the desktop's share picker, as Electron's own under Wayland. `desktopCapturer.getSources` gives one source, "Screen or window" (`screen:0:0`, or `window:0:0` when only windows are asked for), with an empty thumbnail; a page's `getUserMedia()` with it as `chromeMediaSourceId` opens the picker, which says what is captured, sound included when asked. `getDisplayMedia()` opens the same picker, as Electron's `useSystemPicker` does, so a display media handler is kept but not asked (`src/electron/desktop-capturer.ts`) |
| `clipboard` | the desktop clipboard through `wl-paste` and `wl-copy`, which the compositor serves with data-control (docs/use/CLIPBOARD.md), built in the host (`src/electron/clipboard.ts`). Each call waits on its command, as Electron's clipboard is synchronous; a `type` of `selection` is the primary selection. Electron 44's API is there too: `read()` with no format gives the clipboard as one `ClipboardItem` whose types are pasted when asked, `write` takes `ClipboardItem`s, and `clipboard.selection` is the primary selection's. `wl-copy` offers one type per copy, so a `write` of several formats throws, naming them, until the host can offer several. Rich copies in pages go through the engine's own clipboard, which has no such limit. Nix puts `wl-clipboard` on the host's `PATH`; distribution packages recommend it |
| `nativeImage` | the image's PNG or JPEG bytes, in the host. PNGs are read and written without a library (`src/png.ts`) for `resize`, `crop` and bitmaps; a JPEG is kept as it came and can't be decoded, so those throw for one. `addRepresentation` keeps a picture per scale factor, and each call that takes a `scaleFactor` uses the closest |
| `autoUpdater` | off; the app's package updates it |

App menus travel as a JSON model over the Electron socket:
`set_menu_bar {window, menu: [entries] | null, visible, auto_hide}`. The
engine checks the entries, keeps only the keys the shell reads, and lists the
menu with the window (`DomicileBrowserWindow.menu`, `menuBarVisible`,
`menuBarAutoHide`). The shell draws it as a menu bar under the window's tab,
with the menu component the tray uses. A click goes back through
`clickBrowserWindowMenu` to the app as `menu_clicked {window, command}`, the
entry's id. The bar behaves as on Electron for Linux: it follows the app's
`autoHideMenuBar` and `setMenuBarVisibility`, and Alt toggles it. Only a
window has a menu bar; a view's is refused.

Popup menus (`Menu.popup`) go the same way: `popup_menu {window, popup, menu,
x?, y?}` lists `{menu, x, y}` with the window (`DomicileBrowserWindow.popupMenu`),
the point from the page's top left, and the engine fills in the last press in
the page when the app gave none. The shell draws it there and answers through
`answerBrowserWindowPopupMenu` with the entry chosen, or 0 when it was put away
with none; the app hears `popup_menu_closed {window, popup, command}`.
`close_popup_menu {window, popup}` puts it away, answering 0. One is listed at
a time: a newer popup answers the older with 0.

Message boxes travel the same way: `show_message_box {window, box, box_type,
title, message, detail, buttons, default_id, cancel_id, checkbox_label,
checkbox_checked}`, with 1 to 16 buttons. The engine checks the box and lists
it with the window (`DomicileBrowserWindow.messageBox`), one box at a time: a
window that asks another while one shows lists it once the first is answered.
The shell draws it over the window's page and answers through
`answerBrowserWindowMessageBox`, which reaches the app as
`message_box_answered {window, box, response, checkbox_checked}`. A window
that closes under its boxes answers each with its `cancel_id`, as the app
waits on every one. Only a window shows a message box; a view's is refused.

### Unsupported apps

An app the engine can't run yet falls back to its own Electron. When a
sandboxed window asks for `contextIsolation: false`, whose preload would run
in the page's own world without Node, `electron-host` exits with status 3,
whatever the app catches; a window with Node in its page runs on the engine
(see [Preload and IPC](#preload-and-ipc)). `domicile open --electron` then
shows a notification naming the app and runs its own command: the one given
after `--`, else the entry's `Exec`. An app named by its path alone has no
command to fall back to, and the status is passed on. An app the quirks
table names as needing its own Electron exits with status 3 before its main
runs, so its own Electron starts without a window opening on the engine
first.

### Every API

An app must never find a plain `undefined` where Electron has an API: that
is a `TypeError` in the app's main, which takes the app down with no reason
given and no fallback. `scripts/electron-surface.ts` reads `electron.d.ts`
from the newest release of each Electron major, from the latest down to
twelve before 45.2.1's, and from 45.2.1, and writes
`src/electron/surface.ts`: every module, its methods and properties, which
exist only on macOS or Windows, and each instance class's members with its
parents'. `electron-surface.yml` runs it every Monday and, when a new
Electron changes the surface, opens a pull request with coverage.json
measured against it, listing each gap it adds
(`.github/scripts/electron-surface-refresh.sh`). That pull request isn't set
to merge itself: close each new gap, or merge to accept it as listed.

At start the host fills what it lacks from the surface
(`src/electron/complete.ts`):

- A Linux method the host doesn't have exits with status 3, naming it, so the
  app runs on its own Electron, as for [unsupported apps](#unsupported-apps).
- A macOS or Windows method does nothing and gives `undefined`, as
  Electron's does on Linux.
- A property the host doesn't have logs once and reads as `undefined`; an
  object may still set it.
- A name Electron itself doesn't have logs once ("doesn't have on Linux"):
  the surface is stale or the app is probing.

`src/__integration__/coverage.json` lists every gap left: each name an app
would be handed back for ("missing"), find `undefined` for ("absent"), or
that the test can't make an object to measure ("unmeasured").
`coverage.test.ts` measures them on the running host and fails when the
list is off either way, so a gap a new Electron opens, or one a change
closes, is seen. Update it with `UPDATE_COVERAGE=1 bun test coverage`.

A member that answers a constant, such as `isFocused() => false`, is a stub.
The same test finds each one from its source and holds it against
`src/__integration__/stubs.json`, which files it under `lies` (an app acts
on a wrong answer, such as `getFocusedWindow()` always `null`) or `honest`
(right on Domicile, such as `setPosition`, since the desktop places
windows), with why. A new stub, or one that went, fails until it is filed.

Events are held too. A listener on an event that never fires looks like a
working API: Slack's `will-download` listener was there, and nothing called
it. The surface lists each emitter's Linux events (`ELECTRON_EVENTS`), and
`event-coverage.test.ts` counts an event fired when its emitter's host
sources name it. Each one never fired is filed in
`src/__integration__/events.json`, under `gaps` (an app misses it) or
`honest` (nothing to report on Domicile, such as `move`, since the desktop
places windows), with why. A new one, or one that starts firing, fails
until it is filed; the weekly pull request lists each new one.

A preload's side is held the same way. The surface also lists what
`electron.d.ts` gives a renderer, its `electron` modules without what only
the main process has, and what Electron adds to `process`.
`preload-coverage.test.ts` runs the engine's own preload bootstrap
(`kBootstrap` in `electron_preload.cc`) with stand-ins for its natives and
holds what a sandboxed preload gets against
`src/__integration__/preload-coverage.json`: each name it finds `undefined`
for ("absent") or that throws that it doesn't work on Domicile yet
("unsupported"). Its stubs are filed in `stubs.json` too, named
`preload <module>.<member>`. The weekly pull request carries this list as
well.

What the host has is real where the engine can do it and a stated answer
where the shell owns it: window state reads as shown and normal, because
the shell lays windows out, and `globalShortcut` refuses with a warning,
because shortcuts are the shell's. `screen` and `powerMonitor` follow the
desk through `domicile subscribe` from their first use, and
`powerMonitor.getSystemIdleTime` asks `domicile idle-time`, so Slack can mark
you away. `powerMonitor`'s `suspend`, `resume` and `shutdown` follow logind's
`PrepareForSleep` and `PrepareForShutdown` once the app listens, holding each
off with a `systemd-inhibit` delay lock as Electron does
(`src/login-manager.ts`). `systemPreferences.getAccentColor` is the settings
portal's `accent-color`, and `net.isOnline` is Chromium's netlink answer read
from `/sys/class/net`. The
`electron-apps-start-on-a-tty` VM test starts Element and Slack as packaged
and fails on a crash or on Element leaving the engine.

### Phase 2: Node in the page

The engine embeds Node in the page processes of apps that ask for it, as
Electron does. Node, not Bun: pages run on V8, Bun on JavaScriptCore. The
main process moves to the same Node, so both sides load one build of each
native module.

Electron's `main` is on Chromium 160.0.8158.0, three builds from the
engine's 160.0.8155.0, with Node v26.13.1. So the engine takes Electron's
Node as Electron builds it, rather than porting a Node to this V8:

1. **Node in the engine.** Electron's Node fork at the commit its `DEPS`
   names, with its `patches/node`, built by Node's own GN files against the
   engine's V8 and BoringSSL, linked into the engine. The engine binary runs
   as plain Node when told to, as `ELECTRON_RUN_AS_NODE` does.
2. **Node in a page.** A window whose `webPreferences` ask for it
   (`nodeIntegration`, `contextIsolation: false` with a Node preload,
   `sandbox: false`) gets an unsandboxed page process with a Node
   environment in its main world, and libuv run off the renderer's own
   loop, as Electron's `NodeBindings` does. Every other page stays
   sandboxed and Node-free. `require("electron")` in the page is the
   existing preload surface.
3. **The main process on that Node.** `electron-host` runs on the engine's
   Node instead of Bun, with `electron` resolved through Node's module hooks,
   so a native module loads once for both sides.
4. **`<webview>` in Electron pages**, as Zulip uses it, over the guests the
   engine already has.
5. **App by app:** Joplin, Teams for Linux, Zulip and Signal, each leaving
   the quirks table as it runs.

## Apps inspected

Inspected 2026-11-13: every `.node` file's imports and every window's
`webPreferences`.

| App | Phase | Why |
|---|---|---|
| Claude Desktop 5.11492.2 | 1 | Sandboxed pages; N-API modules in main; `WebContentsView`, `utilityProcess`, `safeStorage` |
| VSCodium 1.143 | 1 | 13 N-API modules; sandboxed pages; heavy `sendSync` and custom schemes |
| Element 1.12.33 | 1 | Sandboxed; search index in main |
| Bitwarden 2026.10.2 | 1 | Sandboxed; N-API |
| Mattermost 6.3.2 | 1 | Sandboxed; N-API |
| FreeTube 0.26.0 | 1 | No native modules |
| Super Productivity 19.3.1 | 1 | No native modules |
| Signal 8.32.0 | 2 | Its page loads libsignal and ringrtc |
| Teams for Linux 2.29.0 | 2 | Preload uses Node, `contextIsolation: false` |
| Zulip 5.14.2 | 2 | `@electron/remote`, `<webview>`, `sandbox: false` |
| Joplin 3.7.22 | 2 | `nodeIntegration: true`, `@electron/remote` |
| ChatGPT 26.1103.60933 | none | Needs Owl, OpenAI's Electron fork: throws at start without `app.showTaskManager`, then calls Owl's own APIs |

## Key decisions

- **Extract archives over reading them in place:** Bun's module loader reads
  the file system natively, so patching `fs` as Electron does can't make
  `require` see into an archive. A mirror also serves `loadFile` with no asar
  reader in the engine.
- **One generic host over per-app wrappers:** the quirks table holds what
  differs, so a new app needs no new package.
- **A socket over Mojo for the host:** Bun and Node can't speak Mojo; the
  engine translates at one boundary.
- **Fall back to the app's own Electron over refusing:** a user who lists an
  app still gets a working app.
- **Tray and notifications over D-Bus from the host:** the compositor already
  serves both, and Electron uses the same interfaces on Linux.
- **`dbus-next` for the host's D-Bus:** a pure-JS client that runs under
  Bun. Its optional native socket modules stay unbuilt; the host needs none
  of what they add (fd passing, abstract sockets).

## Plan

- [x] `electron-host`: resolve the app, mirror its resources, the `electron` hook, `app` lifecycle and paths
- [x] engine: the Electron socket and windows (`BrowserWindow` create, load, title, show, close)
- [x] `electron-host`: `BrowserWindow` over the Electron socket
- [x] engine: preload, `contextBridge`, `ipcRenderer` `send`/`on`/`invoke`, `webContents.send`
- [x] `electron-host`: `webPreferences.preload`, `ipcMain`, `webContents.send`
- [x] engine: `sendSync`, message ports
- [x] `electron-host`: `sendSync`, `postMessage`, `MessageChannelMain`
- [x] engine: `protocol.handle`, `loadFile` and sessions
- [x] engine: an app's own schemes, registered at start
- [x] engine: `webRequest`
- [x] engine: cookies, storage clearing, `clearCache`, `setUserAgent`
- [x] engine: permission handlers
- [x] `electron-host`: `protocol.handle`, `loadFile`, `session.fromPartition`
- [x] `electron-host`: `session.webRequest`
- [x] `electron-host`: session cookies, storage clearing, `clearCache`, `setUserAgent`
- [x] `electron-host`: `setPermissionRequestHandler`
- [x] `electron-host`: `utilityProcess`
- [x] engine: views (`set_views`), listed to the shell under their window, and each page's size
- [x] shells: the SDK lists views apart (`browser.views`); Manganese draws them where their apps ask
- [x] `electron-host`: `WebContentsView`, `BrowserView`, `contentView`, `getContentBounds` and `resize`
- [x] `electron-host`: `shell` (`openExternal`, `openPath`, `showItemInFolder`) and `nativeTheme`
- [ ] engine: an app's `nativeTheme.themeSource` reaches its pages' `prefers-color-scheme`
- [x] `electron-host`: `Notification`
- [x] `electron-host`: `nativeImage`
- [x] `electron-host`: `Menu` and `MenuItem` (the model the tray and menu bar draw)
- [x] `electron-host`: `Tray`
- [x] `electron-host`: `dialog` file dialogs
- [x] `electron-host`: `safeStorage`
- [x] `electron-host`: `clipboard`
- [ ] `clipboard.write` of several formats at once
- [x] `desktopCapturer` and `setDisplayMediaRequestHandler`, through the desktop's share picker; engine: a desktop `getUserMedia()` opens it
- [x] engine: app menus (`set_menu_bar`), listed with the window, and clicks back to the app (`menu_clicked`)
- [x] Manganese: app menus as a menu bar under the window's tab; accelerators run their entries; Alt toggles an auto-hidden bar, and Alt with a mnemonic opens a menu
- [x] `electron-host`: `setApplicationMenu`, `setMenu` and the menu bar's settings reach the engine; clicks come back
- [x] engine, Manganese and `electron-host`: popup menus (`Menu.popup`, `popup_menu`), drawn at the app's point or the last press, the choice back to the app (`popup_menu_closed`), which Claude's menu button opens (`guard-electron-menu-bar.sh`)
- [x] engine: message boxes (`show_message_box`), listed with the window one at a time, and answers back to the app (`message_box_answered`)
- [x] Manganese: message boxes over the window's page, the app's buttons in its order; Enter presses its default and Escape its cancel
- [x] `electron-host`: `dialog.showMessageBox`
- [x] `domicile open --electron`: the app from its entry or path, and the fallback to its own Electron
- [x] `electron.apps`: every start of a listed entry goes through `domicile open --electron`
- [x] an app's own schemes kept for the next engine start
- [x] the quirks table: known phase-2 apps go straight to their own Electron
- [x] known apps' schemes (Element, Claude, Slack, ChatGPT, from their own runs) register from the first engine start (`KNOWN` in `packages/domicile-launch/src/electron_schemes.rs`)
- [x] VM test with a fixture app, and memory against the same app on its own Electron (`electron-app-on-a-tty` in `flake.nix`)
- [x] every Electron API an app can call: what the host lacks hands the app back with a reason, never a `TypeError` (`electron-apps-start-on-a-tty` in `flake.nix`)
- [x] engine: a window's own title (`set_title`), hidden windows (`set_hidden`), and the user's close asking the app (`close_asked`); `ipcRenderer` is an EventEmitter (`emit` reaches the preload's own listeners, which Element's preload relies on)
- [x] `electron-host`: `setTitle`, `hide`, `show`, `showInactive`, `show: false`, and the `close` event for the user's close
- [x] engine, Manganese and `electron-host`: window state (`set_window_state`, `window_state`): `maximize`, `minimize`, `restore`, `setFullScreen` and the `is*` calls and events, from what the shell makes the window (`guard-electron-window-state.sh`)
- [x] Manganese: hidden Electron windows off every workspace; app windows drawn with their app's icon
- [x] engine: `webContents.executeJavaScript` and `mainFrame` (a `WebFrameMain` for the page's one frame), which Claude calls at start: the code runs in the page's main world after any load under way, a promise it gives is awaited, and what it gives comes back as JSON carries it (`execute_javascript` and `javascript_result` in `electron_protocol.h`). A throw rejects with a generic reason; the page's console has the exception
- [x] engine: the rest of a sandboxed preload's `electron` module (`webFrame`, `webUtils`, `crashReporter`, `nativeImage`), `process.isMainFrame`, and `additionalArguments` in its `process.argv`, without which Claude's preloads expose nothing and claude.ai shows its web layout (`guard-electron-preload.sh`)
- [x] engine: a sandboxed preload's `process.versions.electron` and `process.resourcesPath`, from `hello`, and the rest of Electron's renderer `process`, `webFrame.insertText` and `setVisualZoomLevelLimits`, each there or saying it doesn't work yet (`guard-electron-preload.sh`, `preload-coverage.test.ts`)
- [x] engine: a sandboxed preload's `process` is an EventEmitter that says `loaded`, `document-start` and `document-end`, without which Slack's preload throws and Slack never signs in (`guard-electron-preload.sh`, `preload-coverage.test.ts`)
- [x] engine: a page's history, loading, focus, renderer pid and crash reach the app (`page_state`), and it walks the history (`go_to_index`, `clear_history`), for `navigationHistory`, `getFocusedWindow` and the rest (`guard-electron-socket.sh`)
- [x] engine: page calls (`page_call`, `page_result`, `devtools_event`): `insertCSS`, `executeJavaScriptInIsolatedWorld`, `capturePage`, `printToPDF`, device emulation, frame subscription and the rest of "Page calls", and `win.setEnabled` and modal windows (`set_ignore_input`)
- [x] engine: the Edit menu's commands and `replace` at the page's focus (`edit`, `replace`), and find in page (`find_in_page`, `found_in_page`, `stop_find_in_page`), with the Edit menu's roles (`guard-electron-socket.sh`)
- [x] engine: a page's context menus reach its app as `context-menu` (`context_menu`), and the shell draws none for it
- [x] engine and `electron-host`: a page's console, preload errors, hangs, fullscreen, media, sound, icons, link, zoom, theme color, cursor and sizes reach its `webContents`; `before-input-event` and `before-mouse-event` hold input for the app, `input-event` and `sendInputEvent`; a page's own mute, user agent and menu shortcuts (`electron_page_reports.h`, patch 0267)
- [ ] engine: a message box before any window has a page, which Element shows when there's no keyring and hands itself back on
- [ ] phase 2, engine: Electron's Node built into the engine, and the engine run as Node
- [x] phase 2, engine: Node in the pages of windows that ask for it (`guard-electron-node.sh`)
- [ ] phase 2, engine: native modules in pages (Node's symbols exported from the engine)
- [ ] phase 2, `electron-host`: the main process on the engine's Node
- [ ] phase 2, engine: `<webview>` in Electron pages
- [ ] phase 2: Joplin, Teams for Linux, Zulip and Signal on the engine, out of the quirks table
