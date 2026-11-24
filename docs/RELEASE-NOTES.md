# Release notes

What's new for shells and apps built on Domicile, in each release. What's new
in the manganese desktop is in
[manganese's release notes](use/RELEASE-NOTES.md).

## 1.3.0

_Unreleased_

### Electron apps on the engine

![Element on the engine, its menu bar drawn by the shell](media/release-electron.png)

Electron apps run on the desktop's engine, and your shell draws their windows, menu bars and message boxes. List the apps in `electron.apps`.

An Electron app answers its pages' sign-ins, certificate errors and client certificates itself, as in Electron; a sign-in it leaves alone still asks through your shell's prompt. Its sessions clear their data, resolve hosts, report their storage path and service workers, run their own preloads, emulate slow or offline networks, and hear their pages' preconnects and spelling dictionaries.

[Menu bars](SHELL-BROWSER-WINDOWS.md#menu-bars) · [Message boxes](SHELL-BROWSER-WINDOWS.md#message-boxes) · [`electron.apps`](SHELL-CONFIG.md#other-sections) · [Design](architecture/ELECTRON-APPS.md) · [#2091](https://github.com/cprussin/domicile/pull/2091) · [#2151](https://github.com/cprussin/domicile/pull/2151) · [#2161](https://github.com/cprussin/domicile/pull/2161) · [#2172](https://github.com/cprussin/domicile/pull/2172) · [#2201](https://github.com/cprussin/domicile/pull/2201) · [#2256](https://github.com/cprussin/domicile/pull/2256)

### Let agents drive the desktop

Claude Code and other agents can see and use the desktop, with the user's permission: `claude mcp add domicile -- domicile mcp`. Agents on the web, like claude.ai and ChatGPT, connect with `agents.web`, one session per chat. An agent lets go when it's done with `stop_using_desktop`. Your shell draws the permission prompt with `<PortalDialogs />`.

[Agents](AGENTS.md) · [`domicile mcp`](CLI.md#domicile-mcp) · [`agents.web`](SHELL-CONFIG.md#agents) · [Dialogs and portals](PORTALS.md#agents)

### Browser profiles

![A page in the Work profile, and its profile menu](media/release-profiles.png)

Profiles with their own sign-ins, site data and extensions, each opening the sites it's given: `browser.profiles` and `<webview profile>`.

[Browser profiles](SHELL-BROWSER-WINDOWS.md#browser-profiles) · [Design](architecture/BROWSER-PROFILES.md) · [#2212](https://github.com/cprussin/domicile/pull/2212) · [#2213](https://github.com/cprussin/domicile/pull/2213) · [#2216](https://github.com/cprussin/domicile/pull/2216) · [#2230](https://github.com/cprussin/domicile/pull/2230)

### Script the desktop

`domicile` commands query and control the desktop from scripts, like `swaymsg`.

[The domicile command](CLI.md) · [#2121](https://github.com/cprussin/domicile/pull/2121) · [#2122](https://github.com/cprussin/domicile/pull/2122) · [#2134](https://github.com/cprussin/domicile/pull/2134) · [#2136](https://github.com/cprussin/domicile/pull/2136)

### A friendlier `domicile` command

Grouped `--help`, `domicile help <command>` for usage and examples, and man pages: `man domicile`. Tables and errors are colored on a terminal (`NO_COLOR` turns it off), and a mistyped command suggests the one you meant. Starting a desktop on a terminal shows what it chose and ticks off each part as it comes up.

[Output](CLI.md#output) · [`domicile help`](CLI.md#domicile-help-command) · [#2418](https://github.com/cprussin/domicile/pull/2418)

### Also new

- A local shell can name its prebuilt module in `package.json` as a package does, `"domicile": { "shell": "dist/shell.js" }`, and `domicile ./my-desktop` serves it without a build. [Distributing](SHELL-PACKAGING.md#distributing) · [#2468](https://github.com/cprussin/domicile/issues/2468)
- `domicile.shell.links(["mailto"])` claims a scheme's links: `domicile open`, apps' links (`xdg-open`, `xdg-email`), pages' `mailto:` links and the Email portal hand them to the shell instead of an app. [Links](WRITING-A-SHELL.md#links)
- `clipboard.remove(id)` drops a clipboard history entry; removing the `current` one empties the clipboard. [System access](SHELL-SYSTEM-ACCESS.md)
- Electron apps control their pages, with `insertCSS`, `executeJavaScriptInIsolatedWorld`, `capturePage`, `printToPDF`, device emulation and frame subscription, and their windows have parents, modals and `setEnabled`. [Page calls](architecture/ELECTRON-APPS.md#page-calls)
- Spell checking in pages and Electron apps, in the languages of `spellcheck`. A context menu event over a misspelling carries `misspelledWord`, `spellingSuggestions` and `replaceMisspelling()`, and runs `add-to-dictionary`. [`spellcheck`](SHELL-CONFIG.md#spelling) · [Context menus](SHELL-BROWSER-WINDOWS.md#the-keyboard)
- HDR and 10-bit color. [`hdr`](SHELL-CONFIG.md#hdr) · [Design](architecture/COLOR.md) · [#1974](https://github.com/cprussin/domicile/issues/1974)
- `<app picture-in-picture>` floats a page's video as a shell window. [Picture-in-picture](SHELL-BROWSER-WINDOWS.md#picture-in-picture-video) · [#2077](https://github.com/cprussin/domicile/pull/2077) · [#2177](https://github.com/cprussin/domicile/pull/2177)
- `system-network`: saved Wi-Fi networks in `Wifi.saved`, with `setWifiAutoJoin()` and `forgetWifi()`, from NetworkManager or iwd. [Libraries](SHELL-SYSTEM-ACCESS.md#libraries) · [#2334](https://github.com/cprussin/domicile/pull/2334)
- `EmptyState` takes `tone="warning"` for something that couldn't be read, with `detail` as its tooltip, and `layout="inline"` for a faint caption under a panel's rows.
- `clickMatch()` clicks a selector's first match in a page. [Browser windows](SHELL-BROWSER-WINDOWS.md) · [#2284](https://github.com/cprussin/domicile/pull/2284)
- `<webview>.history()` for a Back and Forward history menu. [Browser windows](SHELL-BROWSER-WINDOWS.md) · [#2251](https://github.com/cprussin/domicile/pull/2251)
- Pointer lock, confinement and relative motion. [Windows](WRITING-A-SHELL.md#windows) · [#2054](https://github.com/cprussin/domicile/pull/2054) · [#2057](https://github.com/cprussin/domicile/pull/2057) · [#2123](https://github.com/cprussin/domicile/pull/2123)
- Input methods in pages, the shell and native windows. [Design](architecture/TEXT-INPUT.md) · [#2059](https://github.com/cprussin/domicile/pull/2059) · [#2062](https://github.com/cprussin/domicile/pull/2062)
- Shells and app modules are cross-origin isolated, with Web Workers. [Scripts](SHELL-PACKAGING.md#scripts) · [#2182](https://github.com/cprussin/domicile/pull/2182) · [#2183](https://github.com/cprussin/domicile/pull/2183)
- CSS `zoom` on `<app>`. [#2072](https://github.com/cprussin/domicile/pull/2072)
- `chrome.tabs.setZoomSettings` takes Chrome's manual, per-tab and disabled zoom modes. [Browser windows](SHELL-BROWSER-WINDOWS.md) · [#2437](https://github.com/cprussin/domicile/pull/2437)
- Modifier-tap bindings and `--inhibited` chords. [Keybindings](WRITING-A-SHELL.md#keybindings) · [#2065](https://github.com/cprussin/domicile/pull/2065) · [#2030](https://github.com/cprussin/domicile/pull/2030)
- The shell draws "Sign in with" account choosers. ["Sign in with"](SHELL-BROWSER-WINDOWS.md#sign-in-with) · [#2086](https://github.com/cprussin/domicile/pull/2086)
- `windows.bells()`, `toplevelId`, `cursorImage`, minimize and client-side move and resize. [Windows](WRITING-A-SHELL.md#windows) · [#2025](https://github.com/cprussin/domicile/pull/2025) · [#2026](https://github.com/cprussin/domicile/pull/2026) · [#2049](https://github.com/cprussin/domicile/pull/2049) · [#2052](https://github.com/cprussin/domicile/pull/2052) · [#2074](https://github.com/cprussin/domicile/pull/2074)
- `session.idleAfter` and `session.idleBeforeBlanking`. [Idle](SHELL-IDLE-AND-LOCK.md#idle) · [#2073](https://github.com/cprussin/domicile/pull/2073)
- Config: `terminal`, `input.keyboard.repeat`, display `mode`, `refresh`, `adaptive_sync`. [The config](SHELL-CONFIG.md) · [#2024](https://github.com/cprussin/domicile/pull/2024) · [#2031](https://github.com/cprussin/domicile/pull/2031) · [#2048](https://github.com/cprussin/domicile/pull/2048) · [#2069](https://github.com/cprussin/domicile/pull/2069)
- `@domicile-desktop/sdk/config-schema`. [Types and schema](SHELL-CONFIG.md#types-and-schema) · [#2090](https://github.com/cprussin/domicile/pull/2090)
- A Nix binary cache for `stable`. [Install](INSTALL.md) · [#2217](https://github.com/cprussin/domicile/pull/2217)
- `domicile exec` and `KeyAction.Exec` start a program for any shell, and say why when it doesn't start; agents get an `exec` tool. `domicile drag` holds the button while it moves, and `domicile type` presses Return for a line break. [The domicile command](CLI.md) · [Keybindings](architecture/KEYBINDINGS.md)
- `domicile trace <file>` records the engine's frame production to a Perfetto trace. [The domicile command](CLI.md)
- In the journal, logs carry their priority and a name per part: `domicile-compositor`, `domicile-engine`, `domicile-shell`. `journalctl --user -p err` finds errors. [Logs](LOGGING.md)
- `domicile set-log-level trace input` turns the logs up while the desktop runs, for everything or for one subsystem, in the compositor and every engine process. `--reset` turns them back. [Levels](LOGGING.md#levels) · [`domicile set-log-level`](CLI.md#domicile-set-log-level-level-subsystem)
- Quiet by default: each part logs errors alone, and the desktop says one `domicile is up.` line with what it chose and its `DOMICILE_SOCK`. [Logs](LOGGING.md#what-they-say)
- `domicile set-log-level info` tells what changed: windows opening and closing, the screens going dark, the lock, screen casts. `trace input` logs every input event, never which key. [Levels](LOGGING.md#levels)
- A shell's `console.error` is an error in the desktop's logs, shown by default, and `console.debug` shows at `domicile set-log-level debug shell`. `logger("notifications")` from `@domicile-desktop/sdk/logger` names the part of the shell that said each line, as `DOMICILE_SUBSYSTEM` in the journal. [A shell's logs](LOGGING.md#a-shells-logs)
- `domicile set-log-level trace` logs enough to debug from: every message between the desktop and the shell, each commit and frame, each configure, popups, monitors and each control command, each naming its window, surface or display. [Levels](LOGGING.md#levels)
- `domicile logs` prints every part's logs, wherever they went, and `domicile export-logs` saves them to one file to attach to a bug, with web addresses and window titles hidden. [Reading them](LOGGING.md#reading-them) · [`domicile export-logs`](CLI.md#domicile-export-logs---show-everything-file)
- An Electron app hears its pages' console, preload errors, hangs, fullscreen, sound, icons, cursor and sizes, can cancel their keys and mouse events with `before-input-event` and `before-mouse-event`, sends them input with `sendInputEvent`, and mutes them, sets their user agent and turns off their menu shortcuts. [Design](architecture/ELECTRON-APPS.md#windows)
- Chromium 160. [#2023](https://github.com/cprussin/domicile/pull/2023)

### Breaking changes

- Off a terminal, `domicile` no longer prints a `DOMICILE_SOCK=` line of its own: read the socket off the end of the `domicile is up.` line. [Logs](LOGGING.md#what-they-say)
- `extensions.settings.<id>.private` and the SDK's `inPrivate` are gone: a private profile's extensions say what runs there. [Private browsing](SHELL-BROWSER-WINDOWS.md#private-browsing) · [#2237](https://github.com/cprussin/domicile/pull/2237)
- `domicile pointer` no longer takes `press` and `release`: use `domicile drag`. Manganese's `exec` command is gone: `exec()` builds Domicile's `KeyAction.Exec`, and agents call `exec` instead of `send_shell ["exec", …]`.
- `session.idleWarnings` and `idle.warn_before_seconds` are gone: use `session.idleAfter`. [Idle after a time](SHELL-IDLE-AND-LOCK.md#idle-after-a-time) · [#2073](https://github.com/cprussin/domicile/pull/2073)

### Fixes

- `system-audio`: a filter device (such as speaker correction) reads as `muted` when anything it passes through is muted, listed in `through`; `setMuted(id, false)` unmutes the whole chain. Devices behind a filter are marked `filtered`, for pickers to hide.
- Quiet logs: turning up one subsystem shows only its engine lines, pages' and extensions' consoles stay out unless everything is up, and apps the desktop starts log under their own names. [Levels](LOGGING.md#levels) · [Names](LOGGING.md#names)
- A page that has never drawn, such as a new page or an empty ad frame, no longer logs as stalled; a page that drew and stopped still does.
- A `<webview>` hidden with `display: none` keeps its page's tiles, so showing it again draws at once instead of rastering the whole page.
- The pointer theme loading on start no longer logs errors; a missing theme or cursor still does. [Theme](SHELL-CONFIG.md#theme)
- Electron apps log under their entry's name instead of `domicile`, with `electron-host`'s warnings and errors at their own priority. `domicile` run by a binding logs as `domicile-cli`. [Names](LOGGING.md#names)
- Loud failures: software rendering, a stuck fullscreen page and a checked engine each notify and log. [#2071](https://github.com/cprussin/domicile/pull/2071) · [#2088](https://github.com/cprussin/domicile/pull/2088) · [#2051](https://github.com/cprussin/domicile/pull/2051)
- `PortalDialogs` animates a dialog out once answered. `AppChooser` takes `open` and `onOpenChangeComplete` to do the same. [Dialogs and portals](PORTALS.md)
- Captures the engine can't take fail at once. [#2184](https://github.com/cprussin/domicile/pull/2184)
- A renderer that answers the wrong request crashes instead of hanging. [#2215](https://github.com/cprussin/domicile/pull/2215) · [#2248](https://github.com/cprussin/domicile/pull/2248)
- No re-raster while a window animates; hidden windows don't tick the display. [#2227](https://github.com/cprussin/domicile/pull/2227) · [#2143](https://github.com/cprussin/domicile/pull/2143)
- A stuck page flip no longer freezes the desktop. [#2043](https://github.com/cprussin/domicile/pull/2043)
- Electron apps hear their pages' navigations: `will-navigate`, `will-frame-navigate` and `will-redirect` can stop one, so Slack, Element and Claude open plain links in the browser instead of their window, and `did-fail-load` lets them show their offline page. A `beforeunload` that asks to stay asks the app's `will-prevent-unload` instead of showing a dialog, as on Electron. `navigationHistory.restore` and `removeEntryAtIndex` work. [Design](architecture/ELECTRON-APPS.md#windows)
- Popups close when their `PopupScene` changes, such as when an overview opens, and when their `PopupBoundary` moves.
- `windows.focus()` on a popup focuses its window, so a click focusing a native menu no longer closes it before the click arrives. [#2465](https://github.com/cprussin/domicile/issues/2465)
- Electron apps hear the machine suspend, resume and shut down, read the desktop's accent color and whether the machine is online, and get `app`'s window, session and `child-process-gone` events and `webContents`' `ipc-message`. A `net.request` to a `host` with a port reaches that port. [Every API](architecture/ELECTRON-APPS.md#every-api)

Special thanks to: [ploug](https://github.com/ploug) & [mecattaf](https://github.com/mecattaf)

## 1.2.0

_November 10, 2026_

### Chrome never draws over the desktop

Prompts, pickers, tooltips and error pages are the shell's to draw, through `<webview>` events such as `domicile-prompt` and `domicile-picker`. Anything left is refused and logged.

[#1893](https://github.com/cprussin/domicile/pull/1893) · [#1895](https://github.com/cprussin/domicile/pull/1895) · [#1898](https://github.com/cprussin/domicile/pull/1898) · [#1901](https://github.com/cprussin/domicile/pull/1901) · [#1903](https://github.com/cprussin/domicile/pull/1903)

### Gestures

Bind touchpad gestures and touchscreen edge swipes beside keys, in sway's `bindgesture` grammar. Unbound ones reach the app.

[#1913](https://github.com/cprussin/domicile/pull/1913) · [#1925](https://github.com/cprussin/domicile/pull/1925) · [#1928](https://github.com/cprussin/domicile/pull/1928)

### Shells in WebAssembly

Write a shell in Rust or anything that compiles to wasm. `examples/dioxus-shell` is one.

[#1868](https://github.com/cprussin/domicile/pull/1868)

### Also new

- `wlr-gamma-control`, and night light per display. [#1921](https://github.com/cprussin/domicile/pull/1921)
- Touchpad and mouse config. [#1884](https://github.com/cprussin/domicile/pull/1884)
- Pointer hiding. [#1945](https://github.com/cprussin/domicile/pull/1945)
- Touch and pinch reach native apps. [#1911](https://github.com/cprussin/domicile/pull/1911) · [#1924](https://github.com/cprussin/domicile/pull/1924)

## 1.1.2

_November 5, 2026_

- A VMware guest with 3D composites on the GPU. [#1858](https://github.com/cprussin/domicile/pull/1858)

## 1.1.1

_November 4, 2026_

- The engine loads libpulse, so window and screen casts carry sound. [#1849](https://github.com/cprussin/domicile/pull/1849)
- App windows show when the engine's GPU falls back to the CPU. [#1854](https://github.com/cprussin/domicile/pull/1854) · [#1856](https://github.com/cprussin/domicile/pull/1856)

## 1.0.0

_November 3, 2026_

![A shell made of HTML](media/hero.png)

The first release: a Wayland compositor on a Chromium fork, where a shell is a web page.

- Native windows are `<app>` and websites `<webview>`, laid out with CSS.
- Write a shell in HTML, CSS and JavaScript, or React.
- Built in: sharing, screenshots, recording, casting, notifications, the tray, extensions, night light, monitor profiles and a lock screen.
- Packages for Debian, Ubuntu, Fedora, openSUSE, Arch and NixOS, and the SDK on npm.

[Quickstart](SHELL-QUICKSTART.md)
