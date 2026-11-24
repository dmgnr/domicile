# The `domicile` binary

`domicile ./my-desktop/dist/shell.js` starts a desktop. It is one Rust binary.

## Problem

Starting a desktop means:

- resolving a shell path
- picking an ozone platform from environment variables
- starting the engine and the compositor in order
- waiting on stdout and a socket
- cleaning up

This logic is easier to write and test in Rust than in bash. Scripts may
build and start things. All launch logic lives in the binary.
`packages/dev-shell/bin/dev-shell.sh` builds, then calls the binary.

## Design

`domicile` is a `[[bin]]` on `domicile-launch`. That crate already owns the
compositor's command line and the session document. The supervisor needs no
GPU or display, so the crate stays in `default-members` and its tests are
cheap.

```
domicile <shell>                  # run a desktop with this shell
domicile --config <path> <shell>  # ...with this compositor config
domicile which-shell              # ask the running desktop which shell it serves
domicile load-shell <shell>       # replace the running desktop's shell
domicile open <file|url>          # a web link in the running desktop; anything else with its type's default
domicile open --app <url|module>  # a site, or an app module, in an app window (WEB-APPS.md, APP-MODULES.md)
domicile open --which <file|url>  # print the desktop file id `open` would run; nothing for a web link
domicile install-app <url>        # write a desktop entry from the site's web app manifest; needs no desktop
domicile uninstall-app <url>      # remove the entry and icon install-app wrote, given its address or start URL
domicile screenshot               # the shell's interactive screenshot (Print in manganese)
domicile screenshot <file>        # write a PNG of the running desk
domicile send-shell <word>…       # run a shell command, as a SendShell keybinding does
domicile disable-while-typing [on|off|toggle]  # the touchpad's disable-while-typing (RUNNING-A-DESKTOP.md)
domicile theme [light|dark|toggle]  # the desktop's theme, or print it (RUNNING-A-DESKTOP.md)
domicile check-config <file>      # exit 1 with the reason if the compositor refuses this JSON config
domicile power-off                # ask in the Access dialog, then `systemctl poweroff`
domicile reboot                   # ask in the Access dialog, then `systemctl reboot`
domicile log-out                  # ask in the Access dialog, then `loginctl terminate-session`
domicile --help                   # every verb; also -h, help, and <verb> --help
```

Config file:

- `--config` may come before or after the shell.
- Without it, `domicile` looks for
  `$XDG_CONFIG_HOME/domicile/domicile.{ts,tsx,js,mjs,json}`
  (`~/.config/...` when unset). No file means compositor defaults: one output
  that follows the engine's window.
- A missing file means defaults. A file that fails to load is an error, and
  the compositor does not start.
- `--config` with no value, or given twice, is refused. Guessing wrong would
  silently run defaults or fail.
- Verbs never take `--config`. The running desktop read its config at startup.
- `domicile` resolves the default path. The compositor reads nothing from the
  environment (see `arguments`).
- `domicile` passes the chosen path on the compositor command line and prints
  which case applied before starting.

### Modules

Logic lives in pure modules so it can be unit-tested against strings and a
temp directory. The modules that spawn processes or bind sockets stay thin.

| Module | Pure? | What |
|---|---|---|
| `cli` | yes | arguments, and the error for each bad one |
| `components` | yes | finds the engine and compositor from the binary's path or the environment; the builder, bundled shells and app modules when needed |
| `app_host` | yes | `domicile-app-host`: what Domicile's apps spawn to read and write the files the desktop names and reach the engine's history, extensions and site settings |
| `shell_options` | yes | the values in a config's `shell_options` that the shell's `options.json` refuses, for the app host |
| `site_permissions` | yes | a site's permission and setting, as the engine, the control socket and the app host carry it |
| `shell_path` | yes | name or path → module to load and the directory it is served from |
| `shell_source` | yes | classifies a shell argument: module, entry to build, bundled shell, or package |
| `build_progress` | yes | parses builder output into a terminal progress bar |
| `splash` | yes | the splash shown during a slow first build: its copy and its progress file |
| `serving` | yes | asks the engine to load a shell, again while it is starting, and records the shell it serves |
| `platform` | yes | `OZONE` / `WAYLAND_DISPLAY` / `DISPLAY` / `XDG_VTNR` → ozone platform (a console login gets `drm`), or an error saying what to set |
| `control` | yes | control socket requests and replies; takes the engine calls as parameters for the commands it routes |
| `command` | yes | engine command wire: the line, its version, and the reply |
| `arguments` | yes | the compositor's command line; every value explicit, no defaults |
| `config_path` | yes | which config file a run uses: `--config`, the default location, or none, and which case it was |
| `config_watch` | no | watches the config's directory and reports edits |
| `open` | yes | `open`: a web link browses; a file, folder or other link runs its type's default, supertypes counted (`domicile_host::mime_apps`, `domicile_host::shared_mime_info`) |
| `install_app` | no | `install-app`: fetches the page, its manifest and icon through an injected fetch, and writes the entry and icon under the data home |
| `uninstall_app` | no | `uninstall-app`: removes the entry and icons named after the start URL, or whose entry was installed from the URL, without the network |
| `web_app` | yes | the page's manifest link, and the name, start URL and icon a manifest gives |
| `web_address` | yes | resolves a manifest's and its icons' addresses against where they were found; origins |
| `desktop_entry` | yes | the desktop entry `install-app` writes, escaped, its file name, and the address it was installed from |
| `app_entry` | no | the module `open --app` names: its canonical directory and file name |
| `address` | yes | what `open` sends the engine: a URL as given, or a path as a `file://` URL relative to the caller's directory |
| `spawn` | yes | the engine and compositor commands as data, so flag lists are testable |
| `session` | yes | what the compositor publishes once up, and waiting for it |
| `milestones` | yes | what a run must reach to be a desktop, and the message when it doesn't |
| `handshake` | yes | whether a page reached the compositor, and the message when none did |
| `heard` | yes | keeps each component's last output so the run can repeat it on failure |
| `restart` | yes | whether a dead component restarts, which one, the delay, and when to give up |
| `supervise` | no | temp dirs, starting both children in order, the broker socket, teardown |
| `profile_claim` | no | which engine profile this desktop uses: `profile`, or `profile-2`, `profile-3`… when taken |
| `profile_path` | yes | where the engine profile lives (`$XDG_STATE_HOME/domicile/profile`) |
| `control_socket` | no | binds the control socket, replacing a stale one, and carries one line each way |
| `command_socket` | no | dials the engine's command socket, one line each way |
| `graphical_session` | no | tells the systemd user manager the desktop is the graphical session |
| `notification` | no | sends desktop notifications for errors after startup, such as a broken config edit |
| `power` | no | `power-off`, `reboot` and `log-out`: the question in the desktop's Access dialog and the `systemctl` or `loginctl` command |

### Config modules

A `.ts`, `.tsx`, `.js` or `.mjs` config ([SHELL-CONFIG.md](/docs/SHELL-CONFIG.md#a-config-module))
becomes JSON before the compositor sees it:

1. `domicile` runs the builder with `--evaluate`. It bundles the config for
   Bun, with `@domicile-desktop/*` and React from the install and stylesheets
   stubbed.
2. The builder imports it and writes every export but `Shell` and `options` to
   `$XDG_CACHE_HOME/domicile/shells/configs/<key>.json`.
3. `domicile` copies that file to `<runtime>/config.json` and gives the
   compositor that path, which it watches.

The compositor only parses JSON (`domicile-config`). It never runs
JavaScript. `config_watch` re-runs these steps on an edit.

A shell build imports the entry the same way and writes its `options` export
to `options.json` beside `shell.js`. `settings_files` reports it
([WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md#options)).

### Home Manager module

`packages/distro/nix/home-manager.nix` writes the config file that `config_path`
reads. It has one option per field of the `domicile-config` schema and generates JSON
with `pkgs.formats.json`. `configDirectory` adds a config module's exports,
evaluated at build time by the builder.

Every config struct is `deny_unknown_fields`, so one unknown key rejects the
whole file (see Config file) and the desk does not start. So:

- The module runs `domicile check-config` on the file it writes. A refused
  config fails the build.
- `removedSettings` lists settings the schema dropped, by dotted path
  (`output.profiles[].displays[].mode`). Setting one fails an assertion that
  says where it went; `packages/distro/nix/removed-settings.nix` builds them.

Checks:

- `packages/distro/tests/test-the-home-manager-module-agrees.sh` compares option names to
  the Rust structs, without Nix.
- `packages/distro/tests/test-a-dropped-config-field-is-removed-here.sh` fails when a
  config field at any depth is gone since the base commit and
  `removedSettings` lists neither it nor an ancestor.
- `nix flake check` evaluates the module, reads back the file it writes,
  checks that a refused config fails to build, and tests
  `packages/distro/nix/removed-settings.nix` at the top, in a section and in a list.

## Key decisions

### `domicile` builds shells, nothing else

- The engine and compositor are required. A missing one is named. `domicile`
  never runs cargo or turbo and needs no checkout.
- A shell entry (`./desk.tsx`, a `.js` that imports a package) or a package
  (`my-shell`, `github:me/shell`) goes to `libexec/domicile/builder`. The
  builder reports steps as JSON lines, which `domicile` draws as a progress
  bar.
- A built bundle, or a bundled shell (`@domicile-desktop/manganese`, prebuilt
  under `libexec/domicile/shells`), needs no build.
- Users need no build toolchain. The supervisor only spawns the builder; the
  builder owns the bundler
  ([`domicile-builder`](/packages/domicile-builder/README.md)).
- Bun installs and runs the builder and TS configs. Vite transpiles and
  bundles through `shellBuild`, and runs no other compile step. Packages ship
  their CSS prebuilt: manganese's covers its own packages. A project's own
  `vite.config` adds its tools; the builder's shell settings override it.
- `@domicile-desktop/*` and React always come from the install. Two copies of
  React break hooks, and a mismatched SDK speaks a different protocol.
- No fallback shell runs during a slow first build; the splash does. A shell
  the user did not configure looks correct but is wrong.

### Compositor settings stay outside the shell

- Displays and extensions apply before any page exists, and a broken shell
  must not lose the monitors. One config module holds both; each consumer
  reads its own exports.
- home-manager builds a config module with `bun2nix`, so nothing builds at
  login.

### "Desk" is not a user-facing name

No export, config key or CLI word uses it.

### No watch mode

The supervisor contains no bundler. Instead the running desktop takes
commands, like `swaymsg` with sway:

```sh
domicile load-shell ./my-desktop/dist/shell.js
```

- It replaces the running shell with any shell, so it also switches from
  `simple` to `manganese` without restarting.
- Windows survive: the compositor never sees the change, and the browser owns
  browser windows' pages.
- `load-shell` changes only the shell. It does not apply compositor config.
  On load, `announce_open_apps` sends the new page the desktop and its open
  windows, and the browser sends its browser windows.
- The desktop needs no dev mode. `domicile dev <entry>` is a client too: it
  runs the builder's dev server and sends `load-shell` for it, so edits apply
  in place and keep the page's state
  ([WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md#hot-module-replacement)).

`packages/dev-shell/bin/dev-shell.sh` is the watch script built on it:

- The script starts the supervisor itself, so it reads the socket path off
  the end of the supervisor's `domicile is up.` line, which comes once the
  engine runs: an earlier `load-shell` would be refused, because the socket
  exists before the engine does.
- `packages/dev-shell/bin/dev-shell-reload.sh` waits for the bundle to stop changing (a quiet
  period plus a cap). `vite build --watch` writes one build in several steps,
  and reloading mid-write would load a broken shell.
- If the engine refuses a shell, the script prints the engine's `why` and
  waits for the next build. The desktop keeps the previous shell.

### Crashes are recovered

| Exits | Restarted | Keeps running | Lost |
|---|---|---|---|
| engine | the engine | every Wayland app, with its window, state and last frame | browser windows, app modules, and state kept in the shell's page |
| compositor | the compositor | the shell, browser windows and app modules | Wayland apps' connections: most apps exit, and the ones the shell launched start again, without unsaved work |
| the shell's renderer | the engine, which ends itself | as for the engine | as for the engine |

A reload or `load-shell` restarts nothing: every window keeps running, and only
state kept in the shell's page starts over ([No watch mode](#no-watch-mode)).
An engine restarted under `domicile dev` serves the dev server again.

```
the engine exited (signal: 9 (SIGKILL))
starting the engine again in 1s — that is failure 1 of 5 in a row.
```

Engine restart:

- An engine that fails restarts. One that exits 0 restarts only on `drm`
  (`restart::restarts`): there is no window to close there, and
  Chromium exits 0 on `SIGTERM`, so `pkill` reads as a clean exit. A nested
  engine exits 0 when its window closes, which ends the run with
  `the engine exited (exit status: 0)`.
- The launcher removes the dead engine's broker socket. The new engine creates
  one at the same path.
- `EngineSession::reconnect` joins it and re-sends the desktop state: a frame
  sink per window, every client buffer, and each window's last frame.
- Clients keep their `wl_display` connection, so their windows and state
  survive.
- On a tty the screen is blank between engines, because the engine holds DRM
  master. The new engine modesets from the same `DisplaySnapshot`s, and the
  compositor re-sends its connectors once the engine joins.

Compositor restart:

- A compositor that exits 0 ends the run, with
  `the compositor exited (exit status: 0)`. Any other exit restarts the
  compositor under the running engine (`restart::restarts`).
- The launcher removes the dead compositor's chrome socket and session file
  (`clear_the_last_compositor`). The new compositor binds the socket at the
  same path and joins the engine's broker.
- The engine listens on the broker socket again once the old compositor
  disconnects. Each shell page's control channel dials the new compositor.
  The page hears the old compositor's windows close, its system calls end with
  `compositor_gone`, then `compositorreplaced`. See
  [ENGINE-FORK.md](ENGINE-FORK.md#a-compositor-restart).
- The shell and browser windows stay open. Wayland clients lose their display.
  Qt 6.6 and later reconnect (`QT_WAYLAND_RECONNECT=1`); the rest exit.
- The compositor writes each client it launches for the shell (`spawn`, a
  notification's action, a portal) to `launches.json` in the run directory,
  with its pid and start time, and strikes it off when it exits. The next
  compositor binds the same Wayland display and launches again each recorded
  client no longer running (`domicile-compositor`'s `launches`). Startup
  commands are not recorded, since every compositor runs them.
- What this misses: a client started from a terminal or another client, the
  app behind a launcher that forks and exits, and anything a client had not
  saved. A client that reconnected is not followed after that.
- A new desktop removes `launches.json` (`clear_the_last_one`).

Backoff:

- 1s, 2s, 4s, 8s; give up after five failures in a row.
- Each component has its own failure counter. After five engine or
  compositor failures in a row, the launcher counts one desktop failure and
  starts a new desktop.
- A component that ran for a minute resets its counter.

Renderer unavailable:

- Chromium relaunches a crashed GPU process, falls back to the CPU after
  three crashes, and gives up when the CPU fails too. Patch 0178 then exits
  the engine 69 (`EX_UNAVAILABLE`).
- An engine that exits 69 within a minute of starting ends the run
  (`restart::renderer_unavailable`): the launcher prints
  `domicile: renderer unavailable: ...` and exits 69 itself. One that ran
  longer drew on its card and lost the GPU to a cluster of crashes, so it
  restarts like any other failure.

Detecting a new engine:

- The engine calls the C ABI's `disconnected` (`domicile_engine.h`) when its
  browser goes away. The next `hello` is then a new engine.
- An older engine has no `disconnected`. The browser process dials the control
  channel, so `SO_PEERCRED` gives the browser's pid, and a `hello` from a new
  pid also means a new engine
  (`packages/domicile-compositor/src/which_engine.rs`).
- `load-shell` binds a new channel from the same browser, so the pid matches
  and no reconnect happens.

The shell's renderer:

- It dies only through a bug in Domicile, so the engine dies with it rather
  than cover for it with Chromium's sad tab. `SadTabHelper` (patch 0124)
  calls `domicile::DieIfTheShellDied`
  (`components/domicile/browser/shell_death.h`), which `LOG(FATAL)`s:

  ```
  FATAL:shell_death.cc] domicile: the Domicile shell's renderer died (crashed, exit code 139) at domicile://shell/. This is a bug in Domicile; please report it with this log at https://github.com/cprussin/domicile/issues.
  ```

- The supervisor then restarts the engine as for any engine failure. A shell
  that kills its renderer on every start hits the restart limit and the
  desktop stops, saying why.
- Script errors are not this: a shell catches its own with `try`/`catch`,
  `window.onerror` and `unhandledrejection`.
- A `<webview>` page that dies is normal. It reports `renderProcessGone` and
  draws nothing
  ([SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md#crashed-pages)).

### Components are found beside the binary

```
<prefix>/bin/domicile
<prefix>/bin/domicile-compositor
<prefix>/libexec/domicile/engine/     the Chromium tree, with `chrome` inside
<prefix>/libexec/domicile/version     the version and commit `--version` prints
<prefix>/libexec/domicile/builder     builds a shell from an entry or a package
<prefix>/libexec/domicile/shells/     bundled shells and the splash, prebuilt
```

- `current_exe()` reads `/proc/self/exe`, which resolves symlinks. A
  `~/.nix-profile/bin/domicile` symlink finds its siblings in the same store
  output. A `/usr` install works the same way.
- `DOMICILE_ENGINE` and `DOMICILE_COMPOSITOR` override the lookup, for a
  checkout using its own builds. `DOMICILE_ENGINE` is the directory that
  contains `chrome`.
- The flake installs files at these paths. The binary needs no wrapper
  script or environment variables.

## The control socket

`domicile <shell>` runs a desktop. `domicile <verb>` sends a command to the
running one. The first argument decides which.

- Path: `$XDG_RUNTIME_DIR/domicile-ipc.<pid>.sock`, named after the
  supervisor's pid.
- The path is exported as `DOMICILE_SOCK` on the compositor, so every app the
  desktop spawns inherits it, and on the engine, so the Settings app's host
  does ([SETTINGS.md](/docs/SETTINGS.md)).
- One JSON line in, one back, then the connection closes.
  `domicile_launch::control` is the wire; `domicile_launch::control_socket` is
  the socket.
- The supervisor answers each connection on its own thread, since an
  interactive screenshot waits on the user.
- The supervisor answers and routes. `load-shell` and `open`'s web links
  and apps go to the engine. `screenshot` and `send-shell` go to the compositor's chrome socket
  as the `screenshot` and `send_shell` system calls a page makes, and
  `list-displays`, `list-windows`, `status` and `list-shell-commands` as
  `which_displays`, `which_windows`, `which_status` and
  `which_shell_commands`
  (`domicile_launch::compositor_socket`). The connection never says `hello`,
  so it is not a chrome. See
  [KEYBINDINGS.md](KEYBINDINGS.md#commands-from-a-terminal) for where a
  shell command goes from there.
- A whole-desk screenshot times out. An interactive one waits until the shell
  answers or the compositor hangs up. A shell that answers no portal requests
  leaves it waiting until the desktop exits. Ending `domicile screenshot`
  (Ctrl-C) does not withdraw the request or close the shell's dialog.

```
domicile which-shell ─▶ $DOMICILE_SOCK ─▶ supervisor
domicile load-shell  ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ engine ─▶ page
domicile open <url>  ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ engine
domicile open <file> ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ compositor (starts its type's default)
domicile open --app  ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ engine
domicile screenshot  ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ compositor
domicile send-shell  ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ compositor ─▶ every page
domicile list-*, status ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ compositor
domicile disable-while-typing ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ engine
domicile-app-host    ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ engine   (settings_files stops at the supervisor)
```

Several desktops per session:

- Each has its own socket and tells its own apps, so a command reaches the
  desktop it was typed in.
- Each has its own engine profile. Chromium allows one browser per profile and
  forwards a second launch to the first. The first takes `profile`, the next
  `profile-2`, like `wayland-2`.
- A client without `DOMICILE_SOCK` is refused with a message saying what to
  set. It does not scan the runtime directory, because with several desktops
  it would have to guess.
- A socket whose desktop died refuses on connect and says so. A non-socket
  file at the path is left alone.

### Opening links

- `BROWSER` is `domicile-open-url`, set on the compositor next to
  `DOMICILE_SOCK`. It is a separate `[[bin]]`, because most programs run
  `BROWSER` as a single word. It asks the desktop for a browser window
  itself rather than running `domicile open`, which would send a local
  `.html` file back to it.
- The compositor's `PATH` starts with a run directory where `xdg-open` links
  to `domicile-xdg-open`, which runs `domicile open`. Web links open in this
  desktop regardless of `mimeapps.list`; anything else opens with its type's
  default, as the launcher's Enter does.
- Its `xdg-email` links to `domicile-xdg-email`, which runs `domicile open`
  on the `mailto:` link its arguments make. A shell that claims `mailto:`
  gets the link.
- The engine gets the same `PATH` and `XDG_DATA_DIRS`, so a page's app link
  (`slack:`, `zoommtg:`) opens the app its "Open …?" prompt named, and a
  page's `mailto:` link, which Chromium opens with `xdg-email` without
  asking, reaches the shell that claims it.
- `domicile open` picks the handler itself, then has the compositor start it
  as the launcher would: the desktop's environment, its own scope, and an
  activation token. Whoever asked, such as the engine, may lack those.
- The same directory holds the desktop's own `domicile`, so the launcher's
  "Open with" asks this desktop's `open --which`, whatever `domicile` is
  installed, and lists that app first.
- Apps whose wrappers put another `xdg-open` first (nixpkgs wrappers often
  prefix `xdg-utils`) read `mimeapps.list` instead. The package ships
  `share/applications/domicile-mimeapps.list`, and the compositor's
  `XDG_DATA_DIRS` starts with that `share`. It applies only when
  `XDG_CURRENT_DESKTOP` is `domicile`, and nothing is written to the home
  directory.
- The engine opens a browser window at the URL. The shell sees it in its
  window list, so a shell mid-reload gets it with every other window.

### The engine command socket

`load-shell` needs the engine to change which shell it serves. The supervisor
dials a command socket on the engine, passed as `--domicile-command-socket`.

Why a separate socket instead of a new `HostMessage` forwarded by the compositor:

- Which shell to serve is supervisor-to-engine information. The supervisor
  already passes `--domicile-shell-root` and `--domicile-shell-module` at
  launch.
- A `HostMessage` would add a message to the host↔chrome contract that the
  page never uses, and route it through the compositor.
- The compositor stays out of the path, so windows are unaffected.

Wire, one line each way:

```
{"type":"load_shell","version":1,"root":"/x/dist","module":"shell.js"}
{"type":"loaded"}   |   {"type":"refused","why":"…"}
```

- `"dev_server": true` makes `root` the socket of `domicile dev`'s dev server
  rather than a directory
  ([DOMICILE-SCHEME.md](/docs/architecture/DOMICILE-SCHEME.md#dev-server)).
  It is left out otherwise, so an older engine reads every other line.

- The request carries a version, and the engine refuses one it does not
  support. The engine and the supervisor ship separately (`engine-release.nix`
  pins an older engine build), so [DATA.md](/docs/guidelines/DATA.md)'s
  versioning rule applies. The control socket needs no version: both ends are
  the same binary.
- Each connection is one request, so there is no handshake to negotiate a
  version in.
- The engine answers `load_shell` once the new shell ran. One that did not
  run is refused with why, and the engine loads the shell it replaced again,
  so `serving` stays right. The supervisor waits `LOAD_WITHIN` for this.

Engine side:

| File | What |
|---|---|
| `components/domicile/browser/shell_source.{h,cc}` | which shell this process serves; seeded from the two switches, replaceable later |
| `components/domicile/browser/command_protocol.{h,cc}` | the wire: line in, line out, with the action injected; has the tests |
| `components/domicile/browser/shell_swap.{h,cc}` | waits for the new shell to run, and puts the old one back if it does not |
| `chrome/browser/domicile/domicile_command_socket.{h,cc}` | the socket and the shell's window; in `//chrome` because reloading needs `GlobalBrowserCollection`, which `//components/domicile` may not depend on |

Supervisor side:

- `spawn` adds `--domicile-command-socket`, under the run's directory.
- `cli` and `control` add the `load-shell` verb. `cli` validates each verb's
  arguments.
- `control::answer` takes the engine calls (`load`, `open`) as parameters, so
  routing stays string-in, string-out under test.
- The client builds an entry or package before it dials, so `root` and
  `module` name the build output and the wire stays the same.
- The client resolves the path with `shell_path`, using its own working
  directory and `HOME`. Both sockets carry an absolute root and module. A path
  that names nothing is refused in the client's terminal.
- The supervisor records the served shell only after the engine replies
  `loaded`, so `which-shell` reports the loaded shell, and a refused load
  leaves it unchanged.

## Plan

Done:

- [x] `shell_path`, `platform`, `cli`, `components`, `supervise` and the
      `[[bin]]`
- [x] `flake.nix` places the components beside the binary
- [x] control socket and `domicile which-shell`
- [x] engine command socket (fork patch) and `domicile load-shell`
- [x] `packages/domicile-engine/scripts/guard-shell.sh` starts its desktop
      with `domicile`
