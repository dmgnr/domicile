# How it works

Domicile is a Wayland compositor whose renderer is Chromium. The desktop is
one web page, the **shell**. Native windows and websites are elements on it,
laid out by CSS and composited by the engine with everything else on the
page.

## The idea

- **A typical desktop:** the browser is one app. It has its own rendering
  engine and compositor, and draws into a window that a separate desktop
  compositor arranges beside other apps' windows.
- **Domicile:** the browser engine is the desktop compositor. It lays out and
  composites the shell's page, the websites and the native windows together.
- **Why:** to blur the line between websites, native apps and the desktop's
  interface by giving them one layout and one compositor. A separate
  compositor has real strengths too: a small trusted process, any toolkit,
  and isolation from the browser.

## The pieces

| Piece | What it is |
|---|---|
| `domicile-compositor` | The Wayland server, in Rust on Smithay. Apps connect to it. |
| The engine | Chromium with Domicile's patches. It runs the shell, websites and extensions, and draws the screen. |
| The shell | Your desktop: a JavaScript module that exports `Shell(root, domicile)`, served on `domicile://shell/`. |
| `domicile` | The command that starts the engine and the compositor, and builds a shell from source. |

Detail: [ARCHITECTURE.md](/docs/architecture/ARCHITECTURE.md).

## Native windows are `<app>` elements

- An app draws its own window into a GPU buffer, as on any Wayland desktop.
- The compositor hands that buffer to the engine's display compositor (viz)
  as a surface.
- `<app app-id="…">` embeds the surface as an ordinary layer of the page.
  Its layout box sets the window's size.
- So CSS applies to the window as to any element: layout, `transform`,
  `opacity`, `filter`, `mix-blend-mode`, `z-index`, `border-radius` and
  animations. On the GPU these match the same CSS on a `<div>` pixel for
  pixel ([CSS parity](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md#css-parity)).
- The window is composited in the same frame as the page, with no extra
  stage.
- Input reaches the page first. The page reports which window is under the
  pointer and which has focus, and the compositor sends the input to that
  app.

Detail: [WINDOW-COMPOSITING.md](/docs/architecture/WINDOW-COMPOSITING.md),
[ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md),
[`<app>` and `<webview>`](/packages/chrome-sdk/docs/ELEMENTS.md).

## Websites are `<webview>` elements

- A `<webview src="…">` is a browsing context in its own renderer process,
  like a tab.
- Links that open new windows, and `domicile open <url>`, ask the shell to
  show a browser window. The shell places it like any other window.
- Websites are ordinary websites. Only the shell and app modules get the
  `domicile` API.

Detail: [SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md).

## Extensions work across the desktop

- The config lists Manifest V3 extensions from the Chrome Web Store, or
  unpacked directories.
- Each extension's button shows in the shell's tray.
- To `chrome.tabs`, every `<webview>` on the desktop is a tab, on any
  workspace, and the desktop is one window. Asking for a tab
  (`tabs.update(id, { active: true })`) asks the shell to show it.
- Some calls are refused, such as moving or grouping tabs. There are no
  right-click menu items or extension shortcuts.
- Example: [`examples/site-switcher-extension`](/examples/site-switcher-extension)
  lists every website on the desktop and switches to the one picked.

Detail: [EXTENSIONS.md](/docs/architecture/EXTENSIONS.md),
[SHELL-EXTENSIONS.md](SHELL-EXTENSIONS.md).

## Building a desktop

- **Plain JavaScript:** a `shell.js` that exports `Shell`, with no build step.
  See the JavaScript tab of the [quickstart](SHELL-QUICKSTART.md).
- **React:** [`@domicile-desktop/react`](/packages/react/README.md) gives
  hooks for windows, focus and the rest. Any other framework that renders to
  the DOM works too: the shell is a web page.
- **Rust, or anything that compiles to WebAssembly:** a 3-line `shell.js`
  loads the module. See [In Rust](WRITING-A-SHELL.md#in-rust) and
  [`examples/dioxus-shell`](/examples/dioxus-shell).
- **npm:** `domicile ./shell.tsx` transpiles and bundles the file, and
  installs what it imports from npm.
- **Manganese's pieces:** its bar, launcher, notifications and the rest are
  npm packages on the same public API. See
  [SHELL-FROM-MANGANESE.md](SHELL-FROM-MANGANESE.md).
- **Swap it live:** `domicile load-shell ./shell.tsx` replaces the running
  shell and keeps every window open. State kept in the shell's page is lost.
- **Apps:** a desktop app can be a JavaScript module too. See
  [BUILD-AN-APP.md](BUILD-AN-APP.md).

## Performance and limits

Measured, on the build machine with no monitor attached
([measurements](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md)):

- CSS on an `<app>` matches a `<div>`.
- A window is composited in the page's frame.
- A keystroke reaches a composited frame in about 1.7 display frames.

Not measured yet:

- Presentation on a lit monitor, overlay promotion and damage. A change to
  the shell's page damages the whole output.
- The cost of resizing windows.

Worth knowing:

- Electron apps bundle their own Chromium and run as ordinary Wayland apps,
  unless the config lists them to run on the desktop's engine:
  [Electron apps](use/ELECTRON-APPS.md).
- There is no built-in Xwayland. X11-only apps run through xwayland-satellite:
  [X11 apps](use/COMPATIBILITY.md#x11-apps).

More: [KNOWN-GAPS.md](KNOWN-GAPS.md),
[What it runs on](use/COMPATIBILITY.md).

## Try it

- [Install](INSTALL.md), then run manganese in a window on your current
  Wayland desktop.
- [Write a shell](SHELL-QUICKSTART.md) in one file.
