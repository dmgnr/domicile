# Logs

Where Domicile's logs go and how to read them.

## Where they go

- **A login session, or any desktop whose stderr is the journal:** each line is
  a journal entry with a priority and the name of the part that said it.
- **A terminal, or a file stderr was redirected to:** lines are written as each
  part said them.

Domicile checks `JOURNAL_STREAM` against its own stderr, as systemd documents,
so a desktop started from a terminal inside a systemd service still writes to
the terminal.

## What they say

By default, errors alone: something that broke and that you would notice.
Turn more on with `domicile set-log-level` ([Levels](#levels)).

Besides, the desktop says one line when it is up, on stdout:

```text
domicile is up. domicile 1.3.0 · shell /desk/shell.js · config ~/.config/domicile/domicile.json · profile ~/.local/share/domicile/profile · platform drm · DOMICILE_SOCK=/run/user/1000/domicile-ipc.4242.sock
```

`the engine composites on the CPU` joins it when the engine does. Scripts can
wait for `domicile is up.` and read the control socket off the end. A desktop
that ends cleanly says `domicile is down:` and why. On a terminal, it prints
the same as a block instead.

## Names

| Name | What |
|---|---|
| `domicile-compositor` | The compositor's tracing, and its panics. |
| `domicile-engine` | The engine and every process it starts. `DOMICILE_PID` is the process that said it. |
| `domicile-shell` | The shell's `console` messages. |
| `domicile` | The launcher: restarts, and what the desktop chose. |
| `domicile-relay` | Agents on the web: reaching the relay, and its certificate. |
| `domicile-cli` | The `domicile` command when the desktop runs it, such as from a binding. |
| An app's own name, such as `emacs` | What an app the desktop started writes, at `info`, or at the `<n>` priority a line starts with. An Electron app's is its entry's id, such as `element-desktop`; `electron-host` gives its own lines their priority. |

## Reading them

`domicile logs` prints every part's lines, wherever they went, and
`domicile logs --follow` follows them on the journal. To share them, such as on
a bug, `domicile export-logs` writes them to one file with what the desktop
runs on, web addresses and window titles hidden. See
[`domicile logs`](CLI.md#domicile-logs---follow) and
[`domicile export-logs`](CLI.md#domicile-export-logs---show-everything-file).

Settings' Troubleshooting page does the same without a terminal: **Detailed
logging** turns on debug for every part until the desktop restarts, and **Save
logs** saves the export to Downloads ([SETTINGS.md](SETTINGS.md)).

Off the journal, the desktop keeps its newest 10,000 lines for both, so logs
that went to a closed terminal can still be read.

With `journalctl`:

```sh
journalctl --user -b -t domicile-shell           # the shell's console
journalctl --user -b -t domicile-engine -p err   # the engine's errors
journalctl --user -b -t domicile-compositor -f   # follow the compositor
```

Entries carry `CODE_FILE` and `CODE_LINE`: `journalctl --user -b CODE_FILE=dbus/bus.cc`.
The compositor's also carry `TARGET`, the Rust module that said it.

## Priorities

| Priority | Compositor | Engine |
|---|---|---|
| `crit` (2) | | `FATAL` |
| `err` (3) | `ERROR`, and its panics | `ERROR` |
| `warning` (4) | `WARN` | `WARNING`, and lines without Chromium's prefix |
| `notice` (5) | `INFO` | |
| `info` (6) | `DEBUG` | `INFO` |
| `debug` (7) | `TRACE` | `VERBOSE` |

A line without Chromium's prefix continues the line before it, and takes its
priority, when it is indented, as in a stack, or is the rest of a `console`
message. Any other is a warning: a library writing to stderr itself, such as
V8 or Mesa.

## Levels

What each level adds:

| Level | Says |
|---|---|
| `error` | Something broke that you would notice. The default. |
| `warn` | Something unexpected that the desktop got past. |
| `info` | What changed: windows opening and closing, the screens going dark and coming back, the desktop locking and unlocking, screen casts starting and ending, displays being set up again. |
| `debug` | Why: the requests each part handled and what it decided. |
| `trace` | Everything: every input event, with where it landed. |

`trace input` says that a key went down, never which key or what was typed,
so a log of it is safe to share.


Turn the logs up while the desktop runs, for everything or for the subsystems
you are looking into, with `domicile set-log-level`:

```sh
domicile set-log-level trace input      # every input event
domicile set-log-level debug            # everything at debug
domicile set-log-level                  # print the levels set
domicile set-log-level --reset          # back to the starting levels
```

The levels are `error`, `warn`, `info`, `debug` and `trace`. The compositor and
every engine process change at once, and a part that restarts keeps them. They
last until the desktop restarts.

| Subsystem | Covers |
|---|---|
| `input` | Keyboards, pointers, touch, gestures and input methods |
| `displays` | Monitors, modes, scale, color and night light |
| `windows` | App windows, popups, focus and launching apps |
| `rendering` | Frames, buffers, page flips and latency |
| `cast` | Screen sharing, screenshots and casting |
| `portals` | Desktop portals and their dialogs |
| `idle` | Idle, the screen lock and sleep |
| `clipboard` | Copy and paste |
| `notifications` | Notifications and the system tray |
| `electron` | Electron apps on the engine |
| `agents` | Agents that use the desktop |
| `shell` | The shell and its connection to the desktop |
| `session` | Starting, stopping and the login session |

A subsystem turned up shows its own lines and no others. Chromium has one
level per process, so the engine logs everything at the level asked for; the
desktop keeps only the lines from that subsystem's files. A page's or an
extension's `console` shows only with everything at `info` or more, even its
errors: they are the page's, not the desktop's.

Setting everything leaves Smithay and Chromium's own code at their starting
levels; they log too much to read at `debug`.

What `debug` and `trace` add, by subsystem. Each line names the window
(`app_id`), surface, display or process it is about:

| Subsystem | `debug` | `trace` |
|---|---|---|
| `windows` | Windows renamed, dialogs, popups placed and moved, menus grabbing and letting go of the keyboard, the engine's browser windows and their views | Each configure sent, with its size and serial |
| `rendering` | Pages embedded into windows, or refused; frame sinks starting and ending; virtual displays; captures starting and their producer going | Each buffer the engine imports, destroys and submits. Each commit: surface, buffer size, GPU or memory, damage. Each frame the engine takes, draws and presents. Each layout the engine gives a window |
| `displays` | Each monitor the engine reports, plugged in, unplugged or changing refresh, and each display of a new desktop: connector, mode, scale, refresh, HDR | |
| `input` | The engine's input devices changing | |
| `cast` | Captures ending | Each frame captured for a cast |
| `clipboard` | Copies in the browser, by type | |
| `electron` | An Electron app's connection closing | Each request an Electron app makes and each event it gets, by type and window |
| `shell` | Tabs joining extension windows, extension popups opening and closing, and extension windows taking focus | Every message between the desktop and the shell, by type and ids |
| `session` | Each command on the control socket, by type; each part started, with its pid and arguments | |

Lines leave out what someone typed or read: keys, titles, notification text and
clipboard contents.

To start at other levels:

- **Compositor:** `RUST_LOG`, such as `RUST_LOG=debug`.
- **Engine:** `DOMICILE_ENGINE_ARGS`, such as `DOMICILE_ENGINE_ARGS='--log-level=0'`
  or `--v=1`. See [Running a desktop](RUNNING-A-DESKTOP.md).

## A shell's logs

A shell's `console` messages keep their severity: `console.error` is an error,
shown by default, and `console.debug` is a debug line, shown once
`domicile set-log-level debug shell` asks for it. They are filed as
`domicile-shell`.

The SDK's `logger` names the part of the shell that said each line:

```ts
import { logger } from "@domicile-desktop/sdk/logger";

const log = logger("notifications");
log.error("no layout for", id);
log.debug("shown", count);
```

Each line starts with `[notifications]`, and the journal files the name as
`DOMICILE_SUBSYSTEM`:

```sh
journalctl --user -b -t domicile-shell DOMICILE_SUBSYSTEM=notifications
```

manganese logs each window action as `windows` at `debug`: the action, the
windows, screens and workspaces it names, then what changed, such as
`overview=false->true` or `shown=DP-1:1->DP-1:2`. Titles, addresses and
commands are left out.
