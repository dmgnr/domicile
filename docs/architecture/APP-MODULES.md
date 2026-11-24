# App modules

An app is a JavaScript module whose `main` export Domicile calls with a root
element and the desktop, as it calls a shell's `Shell`. `domicile open --app
/path/to/entry.js` opens it in an app window. History and Settings are app
modules ([HISTORY.md](/docs/HISTORY.md), [SETTINGS.md](/docs/SETTINGS.md)),
so Domicile installs no extensions of its own.

## Design

```
domicile open --app ./dist/history.js
  ─▶ supervisor  {"type":"run_app","module":"/abs/dist/history.js"}          control socket
  ─▶ engine      {"type":"run_app","version":1,"root":"/abs/dist","module":"history.js"}  command socket
       registers app-<id> → /abs/dist
       opens an app window, pinned to app-<id>, at domicile://app-<id>/
  ─▶ app page    main(document.body, domicile)
       domicile.files, … ─▶ engine (opaque relay) ─▶ compositor, as an app connection
```

### The module

```ts
import type { AppMain } from "@domicile-desktop/sdk/app";

export const main: AppMain = async (root, domicile) => {
  const notes = await domicile.files.readText("/home/me/notes.txt");
  root.textContent = notes.unwrapOr("no notes");
};
```

With React, `mount(App)` from `@domicile-desktop/react/mount` is a `main`;
`useAppDomicile()` is the desktop below it
([With React](/docs/WRITING-A-SHELL.md#with-react)).

- The module's directory is the app's root. Every file under it is served;
  nothing outside it is.
- The engine writes the document, as for the shell
  ([DOMICILE-SCHEME.md](DOMICILE-SCHEME.md#domicileshell)): charset,
  viewport, a root with no margin, and a meta naming the module. A module that
  fails to load, has no `main`, or whose `main` throws is reported on the page.
- Packaging is a shell's ([SHELL-PACKAGING.md](/docs/SHELL-PACKAGING.md)),
  without the forced CSP. An app that wants a CSP sets one.
- Cross-origin isolated with no headers, as the shell is: `SharedArrayBuffer`
  works and nothing is checked for CORP
  ([DOMICILE-SCHEME.md](DOMICILE-SCHEME.md#cross-origin-isolation)).

### Origin

- `domicile://app-<id>/`, where `<id>` is the first 32 hex digits of the
  SHA-256 of the root's canonical path.
- One origin per root: an app's storage (`localStorage`, IndexedDB, cookies)
  is its own, and two copies of an app in different directories do not share
  it.
- `domicile://shell/` and `domicile://home/` keep their meaning. Any other
  host is refused.

### Windows

- Every `run-app` opens an app window (`isApp`), as `open-app` does. Its
  visits stay out of the history.
- Instances of one app share its origin. They coordinate with
  `BroadcastChannel` or Web Locks.
- The window's guest is pinned to its app at creation. A guest shows a
  `domicile://app-<id>/` page only when pinned to that id, and an unpinned
  guest never shows `domicile://`. Ids are predictable from paths, so without
  the pin a page's `target="_blank"` or an extension's `tabs.update` could
  open any directory as an app.
- Links out of the app and its new windows behave as in any app window
  ([WEB-APPS.md](WEB-APPS.md#design)).

### The host

`main` gets an `AppDomicile`: the shell's `files`, `processes` and `dbus`
([SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md)) and nothing else.
The engine builds it with the SDK's layer over a `DomicileAppHost`, which has
`callSystem()` and the `system` event only.

| An app may | An app may not |
|---|---|
| `read_file`, `write_file`, `create_dir`, `read_dir`, `stat`, `watch` | `screenshot`, `shell_commands`, `send_shell` |
| `spawn` and its `stdin`, `close_stdin`, `kill` | `idle_after`, `idle_before_blanking`, `unlock_refusals` |
| `dbus_call`, `dbus_match`, `unwatch` | `set_window_states`, `window_requests` |
| | `keymaps`, `select_keymap` |
| | every other control channel member: input, focus, windows, lock, theme |

- The engine dials the compositor's socket once per app document and says
  `app_hello` in place of `hello`. After a compositor restart it ends the
  app's calls with `compositor_gone` and dials the new one
  ([ENGINE-FORK.md](ENGINE-FORK.md#a-compositor-restart)).
- The compositor answers an app connection's allowed `system_request`s with a
  `domicile_host::system` executor of its own and fails the rest with
  `permission_denied` (`domicile_host::system::refused_to_an_app`). It drops
  every other message and never adds the connection to the broadcast list, so
  an app hears no desktop events.
- The lock refuses an app's calls as it does the shell's
  ([SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md#security)).
- An app's processes, watches and matches end when its document closes.

### Domicile's own state

An app reaches Domicile's own state through programs it spawns. Each inherits
`DOMICILE_SOCK` from the compositor, as any client does.

| App | Spawns | For |
|---|---|---|
| Settings | `domicile-app-host`, over stdio | config and shell files, site permissions, site data, media devices, extensions |
| History | `domicile-app-host`, over stdio | history, favicons, clearing browsing data |

- Both spawn `domicile-app-host`, framed as a 4-byte length and JSON
  (`domicile_launch::app_host`). It asks the desktop over `DOMICILE_SOCK`, and
  the supervisor relays engine requests over the command socket.
- New engine commands:

  | Command | Replaces |
  |---|---|
  | `extensions`, `set_extension_enabled` | `chrome.management` |
  | `history`, `visits`, `delete_history` | `chrome.history` |
  | `clear_browsing_data` | `chrome.browsingData` |

  `history` returns each row's favicon as a `data:` URL, since an app page
  cannot load `chrome://favicon2`.

### Installing

- Domicile's apps are built into `libexec/domicile/app-modules/<name>/`, or
  `DOMICILE_APP_MODULES/<name>/`. `domicile-history` and `domicile-settings`
  run `domicile open --app` on its `<name>.js`. Nothing is added to the profile.
- `domicile` links `domicile-app-host` into the apps' `PATH`, beside
  `xdg-open`.
- Any other app ships a desktop entry:

  ```ini
  [Desktop Entry]
  Type=Application
  Name=Notes
  Exec=domicile open --app /usr/share/notes/notes.js
  ```

## Key decisions

- **An app module over an unpacked extension.** An extension shows wherever
  extensions show: Settings' Extensions page, `chrome.management` and
  extension switchers such as manganese's. One that needs the system also
  needs a pinned `key`, a native messaging host and a manifest in the profile.
- **A module with `main(root, host)` over an HTML entry.** It matches the
  shell's `Shell(root, domicile)`, and the engine owns the document, so the
  host reaches only the module Domicile ran.
- **The id from the root's path over one the app declares.** No manifest, and
  no app can claim another's storage.
- **The id in the host over a path under one host.** The origin is the
  scheme and host, so storage separates only by host.
- **Trust like a native program.** An app the user runs is as trusted as a
  binary they run: it gets files, processes and D-Bus, and may load remote
  code.
- **No window-manager controls.** A Wayland client cannot read other windows'
  titles or keys, inject input, or drive the lock, so an app cannot either.
  Those stay with the shell.
- **Domicile's state through a spawned host over new `DomicileAppHost`
  members.** A member is an engine release per feature
  ([CONTROL-CHANNEL.md](/packages/domicile-engine/docs/CONTROL-CHANNEL.md#control-channel));
  a host message is not. A native program can run the same host, so this
  grants an app nothing a binary lacks.
- **The engine keeps the id-to-root map.** It serves the files, and the
  supervisor already hands it paths (`load_shell`).

## Plan

- [x] compositor: app connections, system tier only
- [x] engine: `domicile://app-<id>/`, the `main` runner, `DomicileAppHost`,
  `run_app`, guests pinned to an app
- [x] supervisor: `domicile open --app`; SDK: `DomicileAppHost`, `system()`
  takes it; an example app (`examples/minimal-app`)
- [x] guard: `run_app` runs `main`, an app's system call crosses, and a
  `<webview>` not opened for the app cannot open its URL
  (`guard-app-module.sh`)
- [x] Settings as an app: `settings.js`, engine `extensions` and
  `set_extension_enabled`
- [x] History as an app: `history.js`, engine `history`, `visits`,
  `delete_history` and `clear_browsing_data`, relayed by `domicile-app-host`
- [x] remove apps as extensions: `--apps`, `DOMICILE_APPS`, the native
  messaging manifest, `domicile_launch::apps`; update HISTORY.md, SETTINGS.md
  and WEB-APPS.md

## Open questions

- **A `host` call to focus an existing window, for single-instance apps?**
  Recommendation: not yet. Web Locks cover it until an app needs focus.
