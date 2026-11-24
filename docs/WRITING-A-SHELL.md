# Writing a shell

A **shell** is a Domicile desktop's UI: panels, window decorations, launcher,
wallpaper. It is a built web page. Domicile ships two shells (`manganese` and
`simple`); neither is special. This guide covers writing one in its own
repository.

- New here? Start with [SHELL-QUICKSTART.md](SHELL-QUICKSTART.md): a React
  shell in one file. Most shells use
  [`@domicile-desktop/react`](#with-react). This guide's examples use the
  `domicile` object `Shell` is handed; in React, `useDomicile()` returns it.
- [`examples/minimal-shell`](/examples/minimal-shell) is the worked example.
  It pins the SDK published from a `stable` commit and runs on that commit,
  and CI builds it. If this guide and the example disagree,
  the example is right.
- A shell is trusted with the whole session. What that reaches, and what it
  doesn't: [Security](SHELL-SYSTEM-ACCESS.md#security).
- To contribute to Domicile itself, see [`/AGENTS.md`](/AGENTS.md).

More:

- [SHELL-CONFIG.md](SHELL-CONFIG.md): the config file that describes a
  desktop.
- [SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md): browser windows
  (`<webview>`) and `domicile.browser`.
- [SHELL-EXTENSIONS.md](SHELL-EXTENSIONS.md): Chrome extensions' toolbar
  buttons and popups.
- [SHELL-DESKTOP-EVENTS.md](SHELL-DESKTOP-EVENTS.md): displays, theme, system
  tray and notifications.
- [SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md): blanking and the lock
  screen.
- [SHELL-PACKAGING.md](SHELL-PACKAGING.md): bundling and distributing a shell.

## What a shell is

A JavaScript module whose `Shell` export is a function.

- Domicile serves the module, imports it into a page it writes, and calls
  `Shell` with the element to draw in.
- Only `Shell` is read; other exports are ignored. A config module's settings
  exports do not apply when it is loaded as a shell.
- Importing the module may only install its stylesheet. A config module is
  also imported under Bun, which has no DOM, so all DOM work goes in `Shell`.
- If the module fails to load, has no `Shell`, or `Shell` throws, the page
  shows the error.
- The page draws nothing until `Shell` returns, so draw your first frame
  before it does. With React, `mount` does that
  ([With React](#with-react)). A shell that draws later
  fades in from an empty white page.
- The contract is framework-agnostic. `runManganese` is manganese's React
  adapter.
- Each Wayland window becomes an `<app>` element in your page. Where you put
  the element is where the window is. Placing windows is the shell's job.
- The compositor handles clients, input, outputs and pixels.

`<app>` and `<webview>` are tags built into the engine (Domicile's Chromium
fork). Nothing registers them. Write them as you would a `<div>`. `<webview>`
is a browser page; see [SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md).

Style an `<app>` like a `<div>`. A window is a layer in your page's layer
tree, so CSS applies to it directly. `z-index`, `transform`, `border-radius`,
`opacity`, `filter: blur()` and `mix-blend-mode` render bit-exact against an
ordinary element ([measurements](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md)).
Exceptions:

- A client that draws in shared memory instead of on the GPU is copied into a
  GPU buffer. Checked on NVIDIA's driver and on llvmpipe, untested on Mesa
  hardware drivers (AMD, Intel). With no GPU device to copy into, its window
  stays blank. A desktop that composites on the CPU shows it from memory
  ([status](/docs/architecture/WINDOW-COMPOSITING.md#wl_shm-clients-on-a-gpu)).
- `backdrop-filter` over an `<app>` renders but is not pixel-verified; see
  [WINDOW-COMPOSITING.md](/docs/architecture/WINDOW-COMPOSITING.md).

## Running it

```sh
domicile ./my-desktop/dist/shell.js
```

- The module path is the whole interface. Name the file what you like.
- Domicile serves the directory the module is in, over `domicile://`.
- Every shell has the origin `domicile://shell`, so all shells share
  localStorage, IndexedDB, Cache Storage and cookies. A shell loaded later,
  or a new version of yours, reads what earlier ones stored. Prefix your keys
  and database names, and handle data in an older format.

To load a rebuilt bundle, run `domicile load-shell ./dist/shell.js` in a
terminal inside the desktop. Any shell works, and windows stay put
([THE-DOMICILE-BINARY.md](/docs/architecture/THE-DOMICILE-BINARY.md)).

### Hot module replacement

While you work on a shell, serve it from its source instead, in a terminal
inside the desktop:

```sh
domicile dev ./my-desktop/src/shell.tsx
```

- Vite serves your source, and the shell updates as you save. An edit to a
  module that accepts updates keeps the page's state. With
  `@vitejs/plugin-react` in your `vite.config`, that is any React component
  (Fast Refresh).
- An edit nothing accepts, such as one to the entry itself, reloads the shell.
  Windows stay open.
- Ctrl-C goes back to the shell you had.
- Your `vite.config` applies, as in a build. `import.meta.hot` works as in
  any Vite app, including `import.meta.hot.send` and custom events.
- No port opens: the engine reaches the dev server over a socket only you can
  open
  ([DOMICILE-SCHEME.md](/docs/architecture/DOMICILE-SCHEME.md#dev-server)).
- The Settings app shows no options for a shell served this way.

**If your page's renderer dies,** the engine ends with a FATAL line saying
so, and the supervisor starts it again. That is a bug in Domicile, not
your shell's to handle: report it with the log
([THE-DOMICILE-BINARY.md](/docs/architecture/THE-DOMICILE-BINARY.md#crashes-are-recovered)).
Your own script errors are yours: catch them with `try`/`catch`,
`window.onerror` and `unhandledrejection`. A `<webview>` whose page dies
tells you instead
([Crashed pages](SHELL-BROWSER-WINDOWS.md#crashed-pages)).

## The connection

Every example here is in React and in plain JavaScript: pick one with the tabs
above it.

<!-- tab: React -->

```tsx
import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { mount } from "@domicile-desktop/react/mount";

const Desktop = () => {
  const domicile = useDomicile(); // the desktop
  // …
};

export const Shell = mount(Desktop);
```

<!-- tab: JavaScript -->

```js
export const Shell = (root, domicile) => {
  // `domicile` is the desktop
};
```

<!-- /tabs -->

- `domicile`, the second argument to `Shell`, is the desktop: one typed
  object, `Domicile` from `@domicile-desktop/sdk/shell`, with a namespace per
  part (`windows`, `displays`, `keyboard`, `session`, `portals`, `files`,
  `processes` and more). There is nothing to configure.
- It is the only copy. The engine runs your module and calls `Shell` with
  the desktop; there is no `navigator.domicile` or `window.domicile`. Keep it
  however you like (a variable, or with React, `<DomicileProvider>`) and pass
  it to what needs it.
- There is nothing to await and no version handshake. The browser process
  checks the protocol version and logs a mismatch. The first call binds the
  channel.
- State is attributes on each namespace: `windows.list`, `windows.focused`,
  `displays.list`, `theme.current`, `session.locked`, `session.idle` and more.
  Each namespace's `on(type, listener)` says when they change, and returns a
  function that stops listening. Read, then listen. In React, a hook does
  both:

  <!-- tab: React -->

  ```tsx
  const displays = useDisplays(); // rerenders on each change
  ```

  <!-- tab: JavaScript -->

  ```js
  const show = () => draw(domicile.displays.list);
  show();
  domicile.displays.on("change", show);
  ```

  <!-- /tabs -->

- An attribute is `undefined` until the compositor has sent it.
- Moments (`windows.on("focusrequest")`, `keyboard.on("shortcut")`) are
  events too. The engine holds each until its first listener exists, so a
  listener added in React's first effect misses none.
- A call the compositor answers returns a promise of a `Result`
  (`@cprussin/option-result`): `Ok` with the answer, or `Err` with a
  `SystemError`. `files.search` rejects an older search with an `AbortError`
  when a newer one starts.
- Only Domicile calls a shell, so there is no plain-browser case to check
  for. Develop against a real desktop.

**Errors:** log to the console. Page logs reach the terminal Domicile started
from, or the journal as `domicile-shell` ([Logs](LOGGING.md)), at
the severity you logged them. `logger("name")` from
`@domicile-desktop/sdk/logger` names the part of the shell that said each line
([A shell's logs](LOGGING.md#a-shells-logs)). Invalid calls (an empty argv, a keycode of zero, a malformed chord)
throw, because they are bugs in the page.

## With React

`@domicile-desktop/react`, on npm, mounts a React shell and follows the
desktop with hooks:

```tsx
import { mount } from "@domicile-desktop/react/mount";
import { useWindows } from "@domicile-desktop/react/windows";
import type { Shell as ShellModule } from "@domicile-desktop/sdk/shell";

const Taskbar = () => (
  <ul>
    {useWindows().map(({ appId, title }) => (
      <li key={appId}>{title}</li>
    ))}
  </ul>
);

export const Shell: ShellModule = mount(Taskbar);
```

- `mount(App)` is a `Shell` (or an app's `main`). It draws `App` before
  returning, in `StrictMode`, under `<DomicileProvider>`, and shows the error
  in its place if `App` throws.
- `<DomicileProvider domicile>` is what `mount` renders. Use it to mount
  yourself.
- `useDomicile()` is the desktop. `useAppDomicile()` is an app's.
- `/// <reference types="@domicile-desktop/react/elements" />` types `<app>`
  and `<webview>` in JSX.
- Hooks follow the desktop's state: `useWindows`, `useFocusedWindow`,
  `useDisplays`, `useAppearance`, `useIdle`, `useLocked`, and
  `usePortalRequests` and the other portal parts. Each rerenders on change.
- `useWatch(namespace, type, read)` follows any other attribute.
- **Tests:** render under `<FakeDomicile fake={fake}>`
  (`@domicile-desktop/react/fake-domicile`) and drive `fake`, a
  `FakeDomicileHost`.

See [the package's README](/packages/react/README.md).

## In Rust

A shell can be Rust, or any language that compiles to WebAssembly.
[`examples/dioxus-shell`](/examples/dioxus-shell) is the quickstart shell in
[Dioxus](https://dioxuslabs.com):

- Export `Shell` with `#[wasm_bindgen(js_name = Shell)]`. It takes the root
  element and the desktop.
- Bind the parts of `domicile` you use with `wasm-bindgen`. The types to copy
  are in `@domicile-desktop/sdk`.
- Build with `cargo` and `wasm-bindgen --target web`. `domicile` bundles
  JavaScript only, so it doesn't run cargo for you.
- A 3-line `shell.js` loads the wasm and re-exports `Shell`, since Domicile
  calls `Shell` as soon as the module loads:

  ```js
  import init from "./pkg/dioxus_shell.js";
  await init();
  export { Shell } from "./pkg/dioxus_shell.js";
  ```

- Run it with `domicile ./dist/shell.js`.

## The SDK

`@domicile-desktop/sdk`, on npm, provides:

- `Domicile` (the type of the desktop `Shell` is handed) and `Shell`
- `bindKeys`
- `FakeDomicileHost` (`./fake-host`), a desktop for your tests
- types and event names for `<app>` and `<webview>`

Versions are `0.0.0-alpha-<sha>`, one per `main` commit, under the `next`
dist-tag; there is no semver release yet. Depend on the exact version whose `<sha>` matches the Domicile commit
you run, as the example does.

The desktop `Shell` is handed is the API; the SDK is its types plus helpers.
The engine builds it from the SDK's own `src/desktop/` over the host its IDL
describes, in
`packages/domicile-engine/src/third_party/blink/renderer/modules/domicile/`.
The engine routes the pointer and keyboard over an `<app>` to its client, in
the client's own coordinates through every CSS transform, so no helper is
required.

Touchpad pinch over an `<app>` is forwarded to the native client as a Wayland
gesture, and over a `<webview>` it magnifies that page. Neither zooms the
surrounding shell. A shell can take the gesture by canceling its `wheel`
events, as it can other default input handling. A pinch begun with Meta held,
and Meta+scroll, magnify the shell's own page instead, and never reach a
`<webview>`, an `<app>` or the shell's `wheel` listeners.

A finger on an `<app>` reaches the client as a touch point, or as the pointer
for a client that reads no touch. `<app>` has `touch-action: none`, so the
page never pans or zooms under a window. A shell can take a finger by
canceling its pointer events, or bind a swipe in from a screen's edge
(`edge:left`) with `bindKeys`, as it binds touchpad gestures.

**Tests:** hand `FakeDomicileHost`'s `domicile` to your shell. `set` changes
attributes and says they changed, `appear`, `change` and `close` edit the
windows, `dispatch` fires a moment, and `calls` records every call the shell
made of the host underneath.

`@domicile-desktop/component-library` is the React and Panda CSS design
system this repo's shells use. Shells do not need it.

## The smallest shell

<!-- tab: React -->

```tsx
/// <reference types="@domicile-desktop/react/elements" />

import { mount } from "@domicile-desktop/react/mount";
import { useWindows } from "@domicile-desktop/react/windows";

const Desktop = () =>
  useWindows().map(({ appId }) => <app app-id={appId} key={appId} />);

export const Shell = mount(Desktop);
```

<!-- tab: JavaScript -->

```js
export const Shell = (root, domicile) => {
  const mounted = new Map();

  const show = () => {
    const windows = domicile.windows.list ?? [];
    for (const [appId, element] of mounted) {
      if (!windows.some((window) => window.appId === appId)) {
        element.remove();
        mounted.delete(appId);
      }
    }
    for (const { appId } of windows) {
      if (!mounted.has(appId)) {
        const element = document.createElement("app");
        element.setAttribute("app-id", appId);
        root.append(element);
        mounted.set(appId, element);
      }
    }
  };

  show();
  domicile.windows.on("change", show);
};
```

<!-- /tabs -->

This is a working desktop: every window full-screen, newest on top.

- Domicile imports the module and then calls `Shell` once. Do no work at
  import time except CSS. Other exports are ignored. A missing or throwing
  `Shell` is reported on screen.
- Remove the elements `windows.list` no longer lists, or every closed window
  leaks an element. React does this for you.
- Domicile writes the document: a charset, a viewport, and a `<body>` with no
  margin that fills the window. You cannot supply one.
- Only script files next to your module run: no inline scripts, `on…`
  attributes or `eval`. See
  [SHELL-PACKAGING.md](SHELL-PACKAGING.md#scripts).
- `root` is the empty `<body>`. Create your own container in it and render
  there, as `mount` does. Errors are reported by appending to `root`, and a framework that owns
  `root` would wipe them.
- There is no `#root` element. `document.getElementById("root")` returns
  `null`, and the only symptom is a white window.
- Make the background transparent wherever a window should show. A background
  painted over an `<app>` hides it.
- Set `document.title` if you want a title other than Domicile's.
- This shell answers no portal requests, so an app's portal dialog, a bare
  `domicile screenshot` and `domicile screen-record` wait until the desktop
  exits. Answer or refuse them as
  `examples/minimal-shell` does; see [PORTALS.md](PORTALS.md).

### Popups

A client's menus and tooltips are entries in `windows.list` with `parent`
set. So is an input method's candidate list (fcitx5, IBus), over the window
being typed in, just under its text cursor:

- `appId`: the popup's own id
- `parent`: the window or popup (for a submenu) it belongs to
- `x`, `y`: CSS pixels from the top-left of the parent's box; `width`,
  `height`: its size
- `grab`: `true` for a menu, `false` for a tooltip or a candidate list

To show one:

- Mount an `<app>` for it at that position, above its parent. For a zoomed
  window, give it the window's `zoom` (see [Windows](#windows)).
- Give it no frame and do not tile it. Draw it only where its window is drawn.
- Remove it when `windows.list` drops it.
- The engine routes a click on it to its window's keyboard.
- The compositor closes a menu when the keyboard leaves its window.
- A menu placed near a screen edge is not moved back on screen. A candidate
  list is: the compositor puts it above the text cursor near the screen's
  bottom.

## Windows

Each entry in `domicile.windows.list` describes one client window.

- **Identity:** `appId` is the compositor's id for the window, which `<app>`
  takes. `desktopId` is the client's Wayland app id (`set_app_id`), which
  names its desktop entry, for example `org.gnome.Nautilus` for
  `org.gnome.Nautilus.desktop`. It is `""` until the client sets one. Look up
  the entry's `Icon=` to draw the app's icon.
- **Capture handle:** `toplevelId` is the window's identifier on
  `ext-foreign-toplevel-list-v1`. Hand it to a capture tool to name the
  window, for example `grim -T <id>`. It is fixed for the window's life, and
  `undefined` for a popup. Browser windows have their own
  ([SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md#basics)).
- **Owner:** `pid`, `uid` and `gid` name the process that connected the
  window's client, as the kernel recorded it (`SO_PEERCRED`). The client
  cannot forge them; `title` and `desktopId` are its own claims.
  - `pidfdInode` is the inode of that process's pidfd. No other process gets it
    until reboot, so it tells a reused pid apart. `undefined` before Linux
    6.9.
  - All of these are `undefined` for a popup; read its parent's.
  - A process inside a container has its pid in the compositor's pid
    namespace.
- **Sandbox:** `sandboxed` is `true` when the client connected through a
  sandbox engine's `wp_security_context_v1` listener. Such a client sees no
  data control or screen capture globals
  ([PORTALS.md](PORTALS.md#sandboxed-clients)).
  - `sandboxEngine`, `sandboxAppId` and `sandboxInstanceId` are what the
    engine said, for example `org.flatpak`, the Flatpak app id and its
    instance id. `undefined` where it said nothing.
  - They come from `wp_security_context_v1`, so they are claims by whichever
    client created the context. Any unsandboxed client can create one with
    any values.
  - `sandboxInstanceId` is passed through verbatim and is fixed for the
    client's life.
  - Don't base a security decision on them alone. Check them against `pid`,
    `uid` and `gid`, for example the pid plus its start time or
    `pidfdInode`.
- **Cursor:** `cursor` is the CSS cursor a client wants over its window. Set it
  with `element.style.cursor = cursor` (in React, `<app style={{ cursor }}>`).
  A client that draws its own cursor (a game, an image editor, a VM viewer)
  also has `cursorImage`: a CSS `cursor` value holding its image and hotspot,
  to set in place of `cursor`. The engine draws it like any page cursor, so it
  turns with a rotated monitor, hides with the pointer and shows in captures.
- **Pointer lock:** `pointerConstraint` is `"lock"` while a game or VM viewer
  under the pointer asks to lock it in place, and `"confine"` while one asks
  to keep it inside the window. It is offered only for the window under the
  pointer. To grant a lock, call `requestPointerLock()` on the window's
  `<app>`: the engine grants it with no click first and draws no bubble, and
  the element then forwards only relative motion. Once `pointerlockchange`
  says the page holds it, call `windows.pointerConstrained(appId, true)`; only
  then is the client told. Call it with `false` once the lock ends, and end it
  (`document.exitPointerLock()`) when the window loses the keyboard or the
  ask goes away. Escape does not end a lock, since games use it; leaving the
  user a way out, such as a chord that moves the keyboard, is the shell's job.
  Manganese's `followPointerLock` does all of this.
- **Pointer confinement:** for `"confine"`, call
  `pointer.confine(boxes)` with the boxes in the page that hold the pointer:
  the window's `<app>` box, or its `pointerRegion` (boxes in the window's own
  coordinates, which `width` and `height` measure) scaled into it. Then call
  `windows.pointerConstrained(appId, true)`. Call `confine` again as the
  window moves, and `confine([])` plus `pointerConstrained(appId, false)` once
  it loses the keyboard or the ask goes away. A box may reach onto another
  monitor. Nested or headless, `confine` resolves `false` and the pointer is
  not held. Manganese's `usePointerConfinement` does all of this.
- **Size:** the `<app>` element's layout box is the window size. The engine
  sends it to the client. Resize a window by styling its element. Set
  `resizing` on the element while the user drags an edge; see
  [ELEMENTS.md](/packages/chrome-sdk/docs/ELEMENTS.md).
- **Zoom:** set CSS `zoom` on a window's `<app>` to draw its content larger or
  smaller without touching its monitor's scale, as scroll's per-window scale
  does. It stays sharp: the client draws at the zoomed density. Give the
  window's popups the same `zoom`. Their `x`, `y`, `width` and `height` are
  then in zoomed pixels, which `zoom` scales for you when the popup sits in a
  box at the window's top-left corner.
- **On screen:** listed means drawn, not shown. Wait for
  `domicile-presented` on the `<app>` before revealing a window, for example
  to start an open animation. `domicile-suspended` and `domicile-resumed` say
  when its client stops and starts drawing. See
  [ELEMENTS.md](/packages/chrome-sdk/docs/ELEMENTS.md).
- **Listed when drawn:** a window joins `windows.list` with its first frame, so
  its title, `desktopId`, limits and hints are already set.
- **Drawn size:** `width` and `height` are the size the client drew at. The
  engine already uses them for pointer mapping, so you only need them for
  your own UI, such as sizing a dialog.
- **Dialogs:** `dialog` is `true` when the client gave the window a parent or
  a fixed size, as sway reads them. `shell-manganese` floats such a window at
  its drawn size. `dialog` is fixed at the first frame.
- **Parent:** `transientFor` is the `appId` of the window this one is a dialog
  for (`xdg_toplevel.set_parent`), or `undefined`. It follows every change. When the
  parent closes, it names the parent's own parent, as xdg-shell says.
- **Anchor:** `anchor` names the place in your page the client asked to be
  laid out at (`domicile_anchor_v1`), or is `undefined`. It follows every change.
  The names are yours to define. Lay the window's `<app>` out inside your
  anchor element and it moves with your layout in the same frame. Treat a
  name you have no anchor for as `undefined`. `shell-manganese` defines none.
  See [Anchored windows](architecture/WINDOW-COMPOSITING.md#anchored-windows).
- **Urgency:** `urgent` is `true` when the compositor dropped the window's
  focus request (see [A client asking for focus](#a-client-asking-for-focus))
  and the window has not had the keyboard since. It clears when the window gets
  the keyboard, and is never set on the window holding it. Draw it as an
  attention hint, such as a highlighted workspace or title.
- **Client frames:** `clientFrame` is `true` when the client asked to draw its
  own frame. `shell-manganese` leaves its title bar off such a window while it
  floats.
- **Synced frames:** `frame` is the frame to set as the window's
  `<app frame>`, in the same render as the change that came with it, such as
  a popup's move. Call `domicile.windows.syncFrames()` once a page renders it: only
  then does the compositor sync frames. It lasts until the page loads again.
  An `<app>` with no `frame` shows the newest, so a shell that ignores frames
  needs neither. See
  [Synced frames](architecture/WINDOW-COMPOSITING.md#synced-frames).
- **Shortcut inhibitors:** `inhibitsShortcuts` is `true` while the client
  holds `zwp_keyboard_shortcuts_inhibitor_v1`, as a VM or remote desktop
  viewer does. A change fires `windows.on("change")`. See
  [Keybindings](#keybindings).
- **Limits:** `minWidth`, `minHeight`, `maxWidth` and `maxHeight` give the
  client's limits (`undefined` for none). Outside them, the client's frame is cut
  off or stretched. `shell-manganese` keeps floating windows within them.
- **Multiple monitors:** the page spans every monitor, so a window across two
  monitors is one `<app>`, and dragging across the edge is one drag.

### Window states

Tell a client how its window is laid out with its `xdg_toplevel` states:

```ts
import { WindowState } from "@domicile-desktop/sdk/window-state";

await domicile.windows.setStates(appId, [
  WindowState.TiledLeft,
  WindowState.TiledRight,
  WindowState.TiledTop,
  WindowState.TiledBottom,
]);
```

- **Tiled** states say something touches that edge. A client that draws its
  own frame then draws no shadow, rounded corners or resize border there.
- **`Maximized`** and **`Fullscreen`** tell the client it fills its box.
  They do not size the window; the `<app>` box does.
- **`Resizing`** says the shell is resizing the window, such as during a drag
  of its edge, so the client may skip work until it ends. Set it when the drag
  starts and drop it when the drag ends, beside the window's other states.
- Each call replaces the states the shell set and configures the client. The
  compositor's own states (`activated`, `suspended`) are kept.
- States outlive a shell reload. Set them again for every window you lay out;
  setting the same states configures nothing.
- A client bound below `xdg_wm_base` version 2 has no tiled states. Given any
  tiled state and no `Fullscreen`, it gets `maximized` instead, as in sway, so
  it drops its shadows and takes its box's size. A client asking to unmaximize
  stays maximized until the shell's states change.
- An unknown `appId` fails with `SystemErrorKind.NotFound`.

A client asks to be maximized, fullscreen or minimized (a terminal's
fullscreen key, a video player, a title bar's minimize button). The compositor
answers with a configure of the states it has and reports the request. It
grants nothing: nothing changes until the shell sets states.

- `domicile.windows.requests()` streams each request as a
  `WindowRequest`: `Maximize`, `Unmaximize`, `Fullscreen`, `Unfullscreen`,
  `Minimize`, `Move` or `Resize`, with its `appId`. `Fullscreen` carries the
  `display` the client named, if any; `Resize` its `edges`. Moves and resizes
  are below.
- xdg-shell has no minimized state, so `Minimize` is only a request. What
  minimized means, such as hiding the window until it is picked again, is the
  shell's.
- A shell that does not listen ignores every request.

A client that draws its own title bar and borders (GTK and libadwaita apps,
Firefox, Chrome without its system title bar) asks the desktop to move or
resize its window when one is pressed and dragged. The compositor checks the
press is still held, ends it for the client (the pointer leaves, with no
release), and reports `Move`, or `Resize` with the `edges` (a `ResizeEdge`)
the client pulls.

- The button is still down, so the drag is the shell's to run from the page's
  own `pointerdown`: take pointer capture on an element of the shell's, and
  follow the moves until the release. The `<app>` element then stops passing
  the pointer to the client.
- A request that comes after the release has nothing to drag; drop it. A shell
  that ignores the request leaves the window where it is, and the client gets
  the pointer back at the next move over it.

### Bells

A terminal rings its bell (`xdg-system-bell-v1`), and the compositor tells the
shell. It plays no sound and marks nothing itself.

- `domicile.windows.bells()` streams each ring as a `Bell`, with the `appId`
  of the window that rang, or `undefined` when the client named no window.
- What a bell does is up to the shell: flash the window's tab, play a sound,
  or mark the window urgent.

`shell-manganese` tiles with all four tiled states, sets none on floats, and
makes a window fullscreen while its client asks to be.

## Who gets the keyboard

The compositor delivers keys, but your shell decides where they go. With no
handling, a click focuses the window under it and a client's focus request is
ignored.

### A click on a window

The engine fires a cancelable, bubbling `domicile-focus-requested`
(`APP_FOCUS_REQUESTED_EVENT`) on the clicked `<app>`. Unhandled, it focuses
that client. A popup's press asks for its window. A `preventDefault()` on the
`pointerdown` itself takes the whole press: the client gets none of it and
nothing is asked. To apply your own policy:

<!-- tab: React -->

```tsx
import type { AppFocusRequest } from "@domicile-desktop/sdk/app-element";
import { APP_FOCUS_REQUESTED_EVENT } from "@domicile-desktop/sdk/app-element";

const useFocusPolicy = () => {
  const domicile = useDomicile();
  useEffect(() => {
    const asked = (event: Event) => {
      const { appId } = (event as CustomEvent<AppFocusRequest>).detail;
      event.preventDefault();
      if (myPolicySays(appId)) {
        domicile.windows.focus(appId);
      }
    };
    document.addEventListener(APP_FOCUS_REQUESTED_EVENT, asked);
    return () => document.removeEventListener(APP_FOCUS_REQUESTED_EVENT, asked);
  }, [domicile]);
};
```

<!-- tab: JavaScript -->

```js
import { APP_FOCUS_REQUESTED_EVENT } from "@domicile-desktop/sdk/app-element";

document.addEventListener(APP_FOCUS_REQUESTED_EVENT, (event) => {
  const { appId } = event.detail;
  event.preventDefault();
  if (myPolicySays(appId)) {
    domicile.windows.focus(appId);
  }
});
```

<!-- /tabs -->

Key events go to `document`, and the engine forwards them to the focused
client. `domicile.windows.focus` moves both the compositor's seat and where the
page's keys go.

### Taking the keyboard for your own UI

Something always holds the keyboard. It leaves a window when another window
takes it, when a click lands on the shell's own UI, or when you call:

```ts
domicile.windows.focusShell();
```

- Call it when you open a panel to type into (launcher, switcher, palette).
  Otherwise the window underneath keeps receiving the keystrokes.
- Give focus back from whatever normally assigns it. In `shell-manganese`, an
  effect in `AppWindow` asks for the keyboard whenever it is elsewhere, which
  also restores it when a panel closes.

### A click on your window decorations

The engine treats a press outside every `<app>` as the page taking the
keyboard. That is wrong for a title bar or drag handle you drew for a window.
Before taking it, the engine fires a cancelable `domicile-focus-release-requested` on the
`<app>` that holds the keyboard. Cancel it to keep focus on the window:

<!-- tab: React -->

```tsx
import type { AppFocusReleaseRequest } from "@domicile-desktop/sdk/app-element";
import { APP_FOCUS_RELEASE_REQUESTED_EVENT } from "@domicile-desktop/sdk/app-element";

useEffect(() => {
  const asked = (event: Event) => {
    const { appId, pressed } = (event as CustomEvent<AppFocusReleaseRequest>)
      .detail;
    if (isChromeFor(appId, pressed)) {
      event.preventDefault();
    }
  };
  document.addEventListener(APP_FOCUS_RELEASE_REQUESTED_EVENT, asked);
  return () =>
    document.removeEventListener(APP_FOCUS_RELEASE_REQUESTED_EVENT, asked);
}, []);
```

<!-- tab: JavaScript -->

```js
import { APP_FOCUS_RELEASE_REQUESTED_EVENT } from "@domicile-desktop/sdk/app-element";

document.addEventListener(APP_FOCUS_RELEASE_REQUESTED_EVENT, (event) => {
  const { appId, pressed } = event.detail;
  if (isChromeFor(appId, pressed)) {
    event.preventDefault();
  }
});
```

<!-- /tabs -->

`shell-manganese` tags each floating window's bar and drag sheet with its
window and checks that here.

**JSX:** `<app>` has no hyphen, so React treats it as a plain HTML element and
ignores unknown `on…` props. Bind these events with `addEventListener` on a
ref. The same applies to `<webview>` events.

### A client asking for focus

`windows.on("focusrequest", (appId) => …)` is `xdg-activation`: an app
asking to come forward (for example, a browser asked to open a link). The
compositor does not grant it. Call `domicile.windows.focus(appId)` to grant
it, or ignore it.

Only requests made since the keyboard last moved arrive. The compositor drops a
token whose serial is older than the keyboard's last `enter`, or has none: that
is a window taking focus back on its own, not something the user did. Such a
window is marked `urgent` instead. An app that holds the keyboard may pass it to
another of its windows with any token made for input, as Slack does when a
click raises its main window and then a huddle's.

A request that arrives is the shell's to decide, so the compositor marks no
window `urgent` for it: ignoring a request is silent, and the compositor cannot
tell it apart from a grant still on its way. A shell that ignores one and wants
it shown keeps its own mark.

The compositor mints its own tokens for what the user does in the shell:
`processes.launch` (as `XDG_ACTIVATION_TOKEN`) and a notification press (as
`ActivationToken`). So a singleton app launched again, or an app whose
notification was pressed, asks with `focusrequest`. Only the newest such
token is good, for 10 seconds.

### Where focus is

`domicile.windows.focused` is the client that holds the keyboard, `undefined`
while the page holds it; `windows.on("focuschange")` reports changes. Use it,
not your own idea of the active window, to know where keys go. If a focused
client crashes, the compositor gives the keyboard to the page; `windows.list`
drops the window first, so you can focus another.

### Focus follows the mouse

If focus follows the pointer, a keyboard focus change can be undone at once:
the old window is still under the pointer. Move the pointer with
`domicile.pointer.warp(x, y)`, in page coordinates (`clientX`/`clientY`).

- Points outside the page are clamped.
- In a nested run inside another compositor, nothing moves.
- `shell-manganese` warps on its own focus changes (keyboard-driven, or a new
  window taking focus) when the pointer is not already over the window.

### Window scale on several monitors

Call `domicile.windows.setBounds(appId, { x, y, width, height })` with each
`<app>`'s box in page pixels whenever it moves or resizes. The client draws at
the scale of the monitor holding most of the box. A window you never report
draws for the densest monitor. `shell-manganese` reports from `AppWindow`.

Report a window you hide (`display: none`, another workspace) as
`setBounds(appId, { height: 0, width: 0, x: 0, y: 0 })`. Its client then draws about once a second:
the compositor holds its frame callbacks and marks it `suspended` until you
report a box again. A window being cast draws on. A theme change does not wait
for it. A new page starts with every window shown.

## Keybindings

A shell's keys come from its own props. Each chord maps to a shell command or a
binding mode, like sway:

<!-- tab: React -->

```tsx
import { bindKeys } from "@domicile-desktop/sdk/bind-keys";
import { KeyAction } from "@domicile-desktop/sdk/key-action";

const KEYS = {
  keybindings: {
    "Meta+l": KeyAction.SendShell(["focus", "right"]),
    "Meta+r": KeyAction.Mode("resize"),
  },
  modes: {
    resize: {
      "Meta+l": KeyAction.SendShell(["grow", "right"]),
      "Meta+Escape": KeyAction.Mode("default"),
    },
  },
};

const Keys = () => {
  const domicile = useDomicile();
  const [mode, setMode] = useState("default");
  useEffect(
    () =>
      bindKeys(domicile, KEYS, {
        commands: [{ usage: "focus left|right", description: "Move focus." }],
        onCommand: (args) => run(args), // ["focus", "right"] -> Ok("ran") or Err(why)
        onModeChanged: setMode, // "resize", "default"
      }).unbind,
    [domicile],
  );
  return mode === "default" ? null : <p>{mode}</p>;
};
```

<!-- tab: JavaScript -->

```js
import { bindKeys } from "@domicile-desktop/sdk/bind-keys";
import { KeyAction } from "@domicile-desktop/sdk/key-action";

bindKeys(
  domicile,
  {
    keybindings: {
      "Meta+l": KeyAction.SendShell(["focus", "right"]),
      "Meta+r": KeyAction.Mode("resize"),
    },
    modes: {
      resize: {
        "Meta+l": KeyAction.SendShell(["grow", "right"]),
        "Meta+Escape": KeyAction.Mode("default"),
      },
    },
  },
  {
    commands: [{ usage: "focus left|right", description: "Move focus." }],
    onCommand: (args) => run(args),        // ["focus", "right"] -> Ok("ran") or Err(why)
    onModeChanged: (mode) => show(mode),   // "resize", "default"
  },
);
```

<!-- /tabs -->

- A chord is modifiers (`Meta`, `Shift`, `Ctrl`, `Alt`) plus an xkb keysym
  name, joined by `+`.
- The engine finds the key each keysym is on in the configured layout, so
  `Meta+parenleft` works on any layout and follows layout changes.
- A malformed chord throws before anything is grabbed. A keysym the keyboard
  cannot type is logged, and the other keys still work.
- `bindKeys` grabs every chord by name (`domicile.keyboard.grab`), handles each
  `shortcut` by its `chord` whether the press landed on the page or in a
  `<webview>`, handles `Mode` itself, starts every `Exec` (as `domicile exec`
  does; a program that does not start is a notification), and passes every
  `SendShell` to `onCommand`.
- `KeyAction.Hold(press, release)` runs `press` on the chord's press and
  `release` on its release, once per press. The release runs whatever mode the
  keys are in by then; `unbind` runs any still armed. Gestures cannot hold an
  action. For example, `"Meta+Tab": KeyAction.Hold(SendShell(["peek"]),
  SendShell(["unpeek"]))`.
- `onCommand` returns `Ok("ran")`, `Ok({ output })` for a command that
  answers (a query's JSON, which `domicile send-shell` prints), or `Err(why)`
  for a command the shell does not run. A pressed binding's `Err` goes to `reportRefusal`, which logs by
  default.
- `domicile send-shell <word>…` from a terminal reaches `onCommand` too, on
  every page bound. `send-shell` fails with the `Err`, or when no page answers
  within a second. A page that cannot listen calls `report`, which logs by
  default.
- `commands` describes what `onCommand` runs: `domicile list-shell-commands`
  (and `send-shell --help`) prints it. `domicile list-bindings` prints your
  keybindings, which `bindKeys` describes for you.
- It returns `{ setMode, unbind }`. `setMode` keeps one mode across a desktop
  of several pages.
- Command meanings are yours. Describe them in `commands`, and in your README,
  as [manganese does](/packages/shell-manganese/README.md). Manganese takes keys
  from `runManganese({ keybindings })`, defaulting to sway's.
- While bound, a key bound in any mode is taken from every client. `unbind`
  gives the chords back (`domicile.keyboard.ungrab`). Each `grab` needs its
  own `ungrab`.
- A window with `inhibitsShortcuts` gets grabbed chords as keys while it has
  the keyboard; no `shortcut` fires. Let keys through in your own listeners
  too. Design: [KEYBINDINGS.md](/docs/architecture/KEYBINDINGS.md).
- Give the user a way back: write a chord `--inhibited Meta+Escape` and it
  stays yours under an inhibitor. Bind it to
  `domicile.keyboard.switchShortcutsInhibitor(InhibitorAction.Toggle)`
  (`@domicile-desktop/sdk/inhibitor-action`), which turns the keyboard
  window's inhibitor off and on.

## Links

A shell can open links of a scheme itself, instead of the app
`mimeapps.list` names: manganese writes `mailto:` links from its inboxes.

```ts
const claimed = await domicile.shell.links(["mailto"]);
claimed.match({
  Err: (error) => console.error("cannot claim mailto links", error),
  Ok: async ({ items }) => {
    for await (const { url, appId } of items) {
      writeEmail(url, appId);
    }
  },
});
```

- Links come from `domicile open`, and so `xdg-open`, `xdg-email` and apps'
  links, and from the Email portal (`appId` names the app that asked).
- A page's `mailto:` link opens through `xdg-email`, so it comes here too.
- A page's other links (`<webview>`'s `WEBVIEW_EXTERNAL_APP_EVENT`) go to the
  page's listener. Handle claimed schemes there too.
- The page that claimed a scheme last gets its links. `stop()` gives them
  back to the apps.
- `http`, `https` and `file` can't be claimed: `domicile open` browses or
  opens them first.

## The configuration

The user describes the desktop (displays, keyboard, idle, lock, theme,
extensions) in one config file. The compositor reloads it on every change. See
[SHELL-CONFIG.md](SHELL-CONFIG.md).

- Settings of your own shell go in `shell_options`; see [Options](#options).
- The shell owns any other user-facing settings: its own location, schema and
  names.
- `@domicile-desktop/sdk` does not parse the config. Its schema is the
  `domicile-config` crate's, and there is no TypeScript parser for it.

## Options

Options are settings a user changes without editing the shell's code. Declare
them, and the user sets them under `shell_options` in the config or on the
Settings app's **Shell** page ([SETTINGS.md](SETTINGS.md)).

```ts
import { defineOptions, option } from "@domicile-desktop/sdk/options";

export const options = defineOptions({
  clock: {
    format: option.choice("Clock format", ["24h", "12h"], "24h"),
    seconds: option.toggle("Show seconds", true),
  },
  gaps: option.number("Gap between windows", 8, { max: 64, min: 0 }),
});
```

```json
{ "shell_options": { "clock": { "format": "12h" }, "gaps": 4 } }
```

Read them with `watchShellOptions`:

<!-- tab: React -->

```tsx
import type { OptionValues } from "@domicile-desktop/sdk/options";
import { watchShellOptions } from "@domicile-desktop/sdk/options";

const useOptions = () => {
  const domicile = useDomicile();
  const [values, setValues] = useState<OptionValues<typeof options>>();
  useEffect(() => watchShellOptions(domicile, options, setValues), [domicile]);
  return values; // undefined until the first read, in the effect
};
```

<!-- tab: JavaScript -->

```js
import { watchShellOptions } from "@domicile-desktop/sdk/options";

watchShellOptions(domicile, options, (values) => {
  main.style.gap = `${values.gaps}px`;
});
```

<!-- /tabs -->

- Kinds: `toggle`, `choice`, `number` (with an optional `min` and `max`),
  `text` and `list` (of text). A plain object is a group. Each option has a
  label and a default. `defineOptions` throws on a default that its own
  choices or limits refuse.
- Export it from the shell's entry as `options`. The builder writes it to
  `options.json` beside `shell.js`. A prebuilt shell passes it to `shellBuild`
  (`@domicile-desktop/component-library/vite-shell`). A shell with no
  `options` export has no options.
- `watchShellOptions(domicile, options, listener)` calls `listener` with the
  values now and on every change. A change needs no rebuild or reload.
  manganese's React hook is `useShellOptions`
  (`@domicile-desktop/manganese-host/useShellOptions`).
- An option the config leaves out takes its default. An unknown key or a bad
  value is dropped and logged, so the shell starts whatever the file says.
- The Settings app refuses to write a value the declaration refuses. A config
  module that computes `shell_options` is read-only in the form, like its other
  settings.
- Arguments in code win over options. Say in your docs which arguments
  shadow which options; the form cannot see them.
- On the wire: the compositor sends the JSON text in `shell_config`, and the
  desktop exposes it as `domicile.shell.options` with a
  `shell.on("optionschange")` event
  ([CONTROL-CHANNEL.md](/packages/domicile-engine/docs/CONTROL-CHANNEL.md)).

Key decisions:

- **Values in JSON over rewriting code.** A JSON key can be written safely; a
  call's arguments cannot.
- **A declaration over reading prop types.** Types are gone at run time, and a
  form needs labels, defaults and limits.
- **One opaque key over a section per shell.** The compositor's schema stays
  closed and does not change when a shell adds an option.
- **Drop bad values in the shell; refuse them in the host.** The shell must
  start whatever the file says; the app should never write a bad value.
