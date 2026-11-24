# @domicile-desktop/electron-host

Runs an installed Electron app's main process on Domicile, so the app uses
the desktop's engine instead of the Electron it bundles. Design:
[ELECTRON-APPS.md](/docs/architecture/ELECTRON-APPS.md).

## Usage

```sh
bun packages/electron-host/src/main.ts /usr/lib/claude-desktop/resources [app arguments…]
```

1. Mirrors the install's `resources/` under
   `$XDG_CACHE_HOME/domicile/electron/<key>/`: every `*.asar` extracted, the
   rest linked (`src/mirror.ts`, `src/asar.ts`).
2. Reads the app's `package.json` (`src/app-package.ts`).
3. Answers `require("electron")` with the stand-in (`src/electron/`) and
   sets `process.type`, `process.resourcesPath` and
   `process.versions.electron` as Electron does.
4. Runs the app's `main`, then fires `app`'s `ready`.

## What the stand-in covers

- `app`: name, version, `getAppPath`, `getPath`/`setPath` (`src/paths.ts`,
  XDG directories), `whenReady`, `quit`, `exit`, `commandLine` switches.

Anything else is missing, so an app that uses it fails loudly.

## Testing

```sh
bun run turbo test --filter=@domicile-desktop/electron-host
```

`src/__integration__/` runs the host on a fixture app in a child process.
