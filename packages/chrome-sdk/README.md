# @domicile-desktop/sdk

Types and helpers for a Domicile shell: the desktop it is handed, the
`<app>` and `<webview>` elements, keybindings and the `Shell` export.

- Published to npm. To write a shell, start with
  [WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md); this README is the package
  reference.
- Every call's full signature and docs ship in the package's `.d.ts`, so
  your editor shows them. Each namespace's source is
  `src/desktop/<namespace>.ts`, such as
  [`windows.ts`](src/desktop/windows.ts).
- How far a shell's trust reaches:
  [Security](/docs/SHELL-SYSTEM-ACCESS.md#security).

## Usage

```ts
import type { Shell as ShellModule } from "@domicile-desktop/sdk/shell";

export const Shell: ShellModule = (root, domicile) => {
  const show = () => {
    // Render `domicile.windows.list` as `<app app-id="…">` elements into
    // `root`.
  };
  show();
  domicile.windows.on("change", show);
};
```

- Domicile calls `Shell(root, domicile)` once. `domicile` is the only copy of
  the desktop; there is no global.
- `domicile` is a `Domicile`: one typed object with a namespace per subject
  (`windows`, `displays`, `keyboard`, `session`, `portals`, `files`, …).
- Nothing to await. The first call on `domicile` binds the channel.
- State is readonly attributes (`windows.list`, `displays.list`,
  `theme.current`, …), `undefined` until the compositor says. Each
  namespace's `on(type, listener)` says when they change and returns a
  function that stops listening. Read, then listen.
- Moments (`keyboard.on("shortcut")`, `windows.on("focusrequest")`, …) are
  events too. The engine holds each until its first listener exists.
- A call the compositor answers resolves a `Result`. A newer `files.search`
  rejects the older with an `AbortError`.
- Only Domicile calls a shell. Run yours with `domicile ./src/index.ts`.
- Render `<app app-id="…">` and `<webview window="…">` as normal DOM. CSS
  (rounding, blur, transforms, z-index) applies to the live surface.
- The engine sends the pointer, wheel and keys over an `<app>` to its client,
  through every CSS transform. `domicile.windows.focus(appId)` and
  `domicile.windows.focusShell()` move the keyboard without a click.
- Both tags are the engine's built-in elements. In React, bind their events on
  a ref; React does not bind `on…` props for unknown events.
- Errors follow [ERRORS.md](/docs/guidelines/ERRORS.md): bugs throw, absence
  is `T | undefined`.

See [docs/ELEMENTS.md](docs/ELEMENTS.md) for `<app>` input and focus, and the
`<webview>` API.

## Modules

| Module | What it is |
| --- | --- |
| `./desktop/desktop` | `Domicile`, the type of the desktop `Shell` is handed: one typed object, a namespace per subject (`windows`, `browser`, `keyboard`, `files`, `portals`, …). State is attributes with events through `on`; a call that can fail resolves a `Result`. Each namespace's types are in `./desktop/<namespace>`. `desktop(host)` builds one over a host, as the engine does; see [The desktop layer](#the-desktop-layer). |
| `./desktop/app-desktop` | `AppDomicile`, the desktop an app module's `main` is handed: its `files`, `processes` and `dbus`. |
| `./domicile-host` | `DomicileHost`: the engine's host under the desktop. Generated from the engine's IDL; see [Generated types](#generated-types). |
| `./config` | Types for the config file's sections, for a TypeScript config module. Generated; see [Generated types](#generated-types). `./config.schema.json` is the JSON Schema they come from. |
| `./shell` | `Shell`: the export a shell module must provide. Domicile calls it once with the element to draw in and the `Domicile`. |
| `./app` | `AppMain`: an app module's `main`, which Domicile calls with the element to draw in and the `AppDomicile`. See [APP-MODULES.md](../../docs/architecture/APP-MODULES.md). |
| `./app-element`, `./webview-element` | Types and event names for `<app>` and `<webview>`. |
| `./bind-keys` | `bindKeys`: grab a shell's own chords by name and handle them by mode. `./key-action` and `./own-keybindings` are its parts. |
| `./fake-host` | `FakeDomicileHost`: a desktop for a shell's tests. Hand its `domicile` to the shell. |
| `./file-preview` | `previewFile(domicile, path)`: a launcher's preview of a path, read through `domicile.files`: a directory's entries, a song's tags and cover, or the start of a text file. |
| `./dbusmenu` | `watchMenu(domicile, { bus, path })`: a tray item's `com.canonical.dbusmenu` menu, read again on each change, with `click` and `aboutToShow`. Hidden entries are left out; labels lose their mnemonic underscore, and `mnemonic` says where it was. `icon-data` comes as a PNG `data:` URL. See [SYSTEM-TRAY.md](/docs/architecture/SYSTEM-TRAY.md). |
| `./system` | The types of the compositor's system calls: `SystemError`, `FileType`, `Listening`, … The calls are the desktop's `files`, `processes`, `dbus` and the rest; the compositor refuses most while the desktop is locked. See [SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md). |
| `./portal` | The types of application dialogs from `xdg-desktop-portal` (`PortalRequest`, `PortalAnswer`, …) and of running sessions that record the screen or control or capture input (`Capturing`). The desktop's `portals` lists and answers them, and pauses, resumes and discards the shell's own recording; `hideFromCaptures` leaves an element of the shell's out of every capture of the desk; `<PortalDialogs />` in component-library draws them. See [PORTALS.md](/docs/PORTALS.md). |
| `./global-shortcuts` | `fireGlobalShortcuts`: grab the chords applications hold through the GlobalShortcuts portal and report each press and release. `<PortalDialogs />` calls it. |
| `./options` | `defineOptions` and `option`: the options a shell declares as its `options` export, which the Settings app edits. `watchShellOptions` reads the config's values of them, live. See [WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md#options). |
| `./icon-theme` | `readIconTheme(domicile)`: the config's `theme.icon_theme`, read from the compositor's Settings portal, or `None` for `hicolor` only. `watchIconTheme` reads it and follows `SettingChanged`. `@domicile-desktop/system-apps/app-icons` takes it. |
| `./extension`, `./tray`, `./notification`, `./theme`, `./display-transform` | Data types and Zod schemas for what the desktop holds. |

Internal, not needed by shells: `./cursor-shape`.

The compositor's JSON socket protocol lives in
[`@domicile-desktop/e2e-harness`](../e2e-harness/README.md); a page never
speaks it.

## Design

- **One typed object, a namespace per subject.** If the desktop has it, it is
  a member of `domicile`. SDK functions are for policy and composition
  (`bindKeys`, `watchShellOptions`), not for reaching the desktop.
- **State is attributes with a bare change event**, over events that carry
  the value. The attribute is the one source of truth, and a late listener
  misses nothing (`navigator.onLine` with `online` works the same).
- **The engine holds moments** (`focusrequest`, `shortcut`) until the first
  listener of their type. Only the engine knows whether a listener exists.
- **Asks return promises.** A newer `files.search` rejects the older.
- **The desktop is handed to `Shell`**, not found on a global. There is no
  `navigator.domicile` or `window.domicile`; the shell's copy is the only one.
- **The engine reports the desktop's size and density**, and `<app>` routes
  its own input ([docs/ELEMENTS.md](docs/ELEMENTS.md)). Chords are resolved by
  the engine ([KEYBINDINGS.md](/docs/architecture/KEYBINDINGS.md)).
- **The SDK is the desktop's types, the layer that builds it, and pure
  helpers.** The host types under it are generated from the IDL, below.

## Working on this package

For contributors to this repository. Shell authors don't need it.

- Ships built JavaScript and `.d.ts` from `dist/`. Run `bun run build` before
  anything outside the workspace imports it.
- Develop a shell against the real desktop with
  `packages/dev-shell/bin/dev-shell.sh <shell>`.

### The desktop layer

The engine hands a shell the `Domicile` that `src/desktop/desktop.ts`'s
`desktop(host)` builds, and an app the `AppDomicile` of `appDesktop(host)`.
It does not build them itself: `codegen/generate-engine-layer.ts` bundles
`src/desktop/layer.ts` into the engine as `domicile_layer.js`, which the
engine evaluates on each shell and app page.

```sh
bun run generate    # after changing anything under src/desktop/
```

- A change to the layer is an engine change: it needs an engine release
  ([RELEASES.md](/packages/domicile-engine/docs/RELEASES.md)).
- `packages/domicile-engine/tests/test-engine-layer-is-the-sdks.sh` fails when the file is stale.
- The engine's guards export `HostShell` instead of `Shell` to be handed the
  host itself; see [GUARDS.md](/packages/domicile-engine/docs/GUARDS.md).

### Generated types

`src/domicile-host.ts` is generated from the engine's WebIDL in
`packages/domicile-engine/src/third_party/blink/renderer/modules/domicile/`,
with the IDL's comments as its docs. Do not edit it.

```sh
bun run generate    # after changing the IDL or domicile-config
```

- `codegen/` holds the generator: a parser for the IDL subset the engine uses,
  and the TypeScript it emits. It throws on syntax outside that subset.
- `EVENT_TYPES` in `codegen/generate-domicile-host.ts` names the event type
  each `on<name>` handler dispatches, which WebIDL cannot express.
- `packages/domicile-engine/tests/test-host-types-match-the-idl.sh` fails when the file is stale.

`config.schema.json` is the JSON Schema `schemars` derives from
`domicile-config`'s Rust types. Generated from it, with the Rust doc comments
as their docs:

- `src/config.ts`: the config's types.
- `src/config-schema.ts`: a Zod schema that reads a config as the compositor
  does, defaults filled in. Read a config with it, never a copy of the schema.

`bun run generate` writes all three and needs `cargo`.

- `codegen/json-schema.ts` parses the schema subset `schemars` emits. It
  throws on a keyword outside it.
- `tests/test-config-types-match-the-schema.sh` fails when any file is stale.

### Dependencies

- `zod` only. Its schemas parse the keywords and rows a newer engine may send
  unknown values for, such as `./cursor-shape`.
- `@cprussin/option-result` gives `./system`'s calls their `Result`.

### Test

```sh
bun run turbo test --filter @domicile-desktop/sdk
```

- React's dev build logs an unknown-tag warning for `<app>` in a shell's tests
  only.
