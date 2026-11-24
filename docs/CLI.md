# The `domicile` command

`domicile` runs a desktop, and sends commands to the one running.
`domicile --help` lists them. Commands for the running desktop work from any
terminal on it.

## `domicile [shell]`

Run a desktop.

```sh
domicile                                  # the shell your config names
domicile @domicile-desktop/manganese      # manganese
domicile ./shell.tsx                      # a shell entry, built for you
domicile ./dist/shell.js                  # a built shell
domicile ./shell.js --config ./desk.json  # with another config file
```

- With no shell, it runs the one the config names: a JSON config's `"shell"`,
  or a config module's `Shell` export.
- The config is `~/.config/domicile/domicile.{ts,tsx,js,mjs,json}` unless
  `--config` names one. On a terminal, it prints which it used.
- A `.ts`, `.tsx` or a `.js` with bare imports is built first, with React and
  `@domicile-desktop/*` from Domicile's install. So are npm and `github:`
  packages ([SHELL-PACKAGING.md](SHELL-PACKAGING.md#distributing)).
- In a Wayland session it opens in a window; from a console login it takes
  the screen.

On a terminal it says what it chose, then each part as it comes up:

```text
domicile 1.3.0
  shell     @domicile-desktop/manganese
  config    ~/.config/domicile/domicile.ts
  profile   ~/.local/state/domicile/profile
  platform  drm
  socket    /run/user/1000/domicile-ipc.4242.sock

  ✓ Shell built in 2.4 s
  ✓ Engine up
  ✓ Compositor up · WAYLAND_DISPLAY=wayland-1

Desktop running. Ctrl-C to stop.
```

`socket` is the `DOMICILE_SOCK` for commands from a terminal outside the
desktop. Off a terminal it says one line instead ([Logs](LOGGING.md#what-they-say)).

## `domicile which-shell`

Print the shell the running desktop serves.

## `domicile load-shell <shell>`

Serve another shell, or a new build of the same one. Windows stay open. It
takes the same forms as `domicile [shell]`.

- A failed build prints the error and keeps the running shell.
- A shell that fails to run (it will not load, has no `Shell`, or `Shell`
  throws) prints why, and the desktop goes back to the shell it had.
- A module rebuilt in place has no old shell to go back to, so it stays on its
  error screen.

## `domicile dev <entry>`

Serve a shell from its source, with hot module replacement, until Ctrl-C.
Then the desktop goes back to the shell it replaced. `<entry>` is the file the
shell's source starts at, such as `src/shell.tsx`
([WRITING-A-SHELL.md](WRITING-A-SHELL.md#hot-module-replacement)).

- An edit Vite can apply in place keeps the page's state. Any other edit
  reloads the shell, and windows stay open, as with `load-shell`.
- The dev server's log, such as each update it sends, prints in this
  terminal.
- A failed build or a dev server that stops prints why, and the desktop goes
  back to the shell it replaced.

## `domicile open <file|folder|url>`

Open a file or folder with its type's default app, or a link in a browser
window ([LAUNCHER.md](LAUNCHER.md#opening-files)).

- `domicile open --profile <id> <url>` opens a link in browser profile `<id>`
  ([BROWSER-PROFILES.md](architecture/BROWSER-PROFILES.md)). Without it, a
  link opens in the profile its site opens in. A profile the config doesn't
  name is an error.
- `domicile open --app <url|module>` opens a site or an app module as an
  app: its own window, without an address bar
  ([WEB-APPS.md](architecture/WEB-APPS.md)).
  - `--id <id>` makes a site's window app `<id>`'s.
  - `--profile <id>` opens a new window in that browser profile rather than
    its site's.
  - `--reuse focus` brings `<id>`'s open window to the front instead of
    opening another; `--reuse navigate` also loads the address in it. Both
    need `--id`. `new`, the default, always opens a window.
- A link of a scheme the shell claims, such as manganese's `mailto:`, goes to
  the shell instead of an app ([Links](WRITING-A-SHELL.md#links)).
- `domicile open --which <file|url>` prints the app `open` would use.
- `domicile open --electron <entry|path> [-- <command>...]` runs an installed
  Electron app on the desktop's engine instead of the Electron it ships:
  `domicile open --electron slack.desktop`. `<entry>` is a desktop entry id;
  `<path>` is the app's install or its program. `<command>` is the app's own
  command line, which runs it on its own Electron, with a notification, if a
  page needs what the engine doesn't do yet
  ([ELECTRON-APPS.md](architecture/ELECTRON-APPS.md)).
- Apps on the desktop run it for `xdg-open` and `$BROWSER`.

## `domicile install-app <url>`

Add a site to your applications, named and drawn from its web app manifest.
It opens with `domicile open --app`.

## `domicile uninstall-app <url>`

Remove a site `install-app` added, given the same address.

## `domicile screenshot [file]`

With no file, open the shell's screenshot picker. The picture goes in
`Pictures/Screenshots` and its path is printed; Ctrl+C in the picker copies
it instead. With a file, write every monitor to it as a PNG, without asking.
Exits 1 if the picker is dismissed.

## `domicile screenshot --fit <px> [--area <x>,<y>,<w>x<h>] <file>`

Write a PNG of every monitor to `<file>`, shrunk so neither side is over
`<px>` pixels, without asking. Print what it shows as JSON: the desktop it
covers in logical pixels, and its size. `--area` takes only that area of the
desk, in logical pixels; an area not all on the desk is refused.

```
$ domicile screenshot --fit 1280 desk.png
{"place":{"position":[0,0],"size":[3840,1080]},"width":1280,"height":360}
```

A point in the PNG is a point for `pointer`, scaled by `place.size` over
`width` and `height`.

## `domicile pointer <x>,<y> [click|double-click|right-click|middle-click]`

Move the pointer to `<x>,<y>`, in logical pixels from the desk's top-left
corner, then click the left, right or middle button there.

## `domicile drag <x>,<y> <x>,<y>`

Press the left button at the first point, move to the second in steps over
about a sixth of a second holding it, and let go there. Points are as
`pointer` takes them.

## `domicile scroll <dx>,<dy>`

Scroll where the pointer is, in logical pixels: positive is right and down.

## `domicile key <chord>`

Press the keys of a chord in order, then release them in reverse. Each key is
an XKB keysym name, such as `Return`, `Tab`, `l` or `F4`, in any case;
`ctrl`, `shift`, `alt` and `super` name the left modifiers.

```
domicile key ctrl+shift+Tab
```

## `domicile type <text>`

Type `<text>` on the desk's keyboard, holding Shift where a character needs
it. A line break presses Return. Refused, typing nothing, when no key types a
character without AltGr.

## `domicile accessibility <window>`

Print a native window's [AT-SPI](https://gitlab.gnome.org/GNOME/at-spi2-core)
accessibility tree, one element a line: its role, name, ref, an editable
text's text, and whether it is focused, checked, pressed, expanded or
selected. `domicile mcp` reads native windows with it.

```
$ domicile accessibility kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA
- frame "notes.txt" [ref=:1.7/org/a11y/atspi/accessible/1]
  - push button "Save" [ref=:1.7/org/a11y/atspi/accessible/12]
  - text [ref=:1.7/org/a11y/atspi/accessible/13] text="hello" focused
```

- The window is found by its process and title, so an app that does not
  support accessibility, or one sandboxed in another process, is refused.
- Elements that are not visible are left out, with what is under them, and a
  password's text is never printed. Past 1,500 elements the outline is cut.
- It needs the accessibility bus, which at-spi2-core runs
  (`services.gnome.at-spi2-core.enable` on NixOS).

## `domicile accessibility-act <window> <ref> click|focus|set-text <text>`

Click an element of a native window by its ref from `accessibility`, give it
the keyboard focus, or replace its text. Clicking runs the element's own
click, press or activate action, so it works on a window the desk hides. A
ref of another process is refused.

## `domicile devtools [--view <view>] <window> <method> [params]`

Send one [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
method to a browser window's page, with its params as a JSON object, and print
its result as JSON. `<window>` is an id `list-windows` prints, or `shell` for
the shell's own page: its bars, panels and dialogs. `--view` sends
it to one of the window's views instead, by the id `list-windows --json`
lists. `domicile mcp` drives browser windows with it.

```
$ domicile devtools Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE DOM.getContentQuads '{"backendNodeId":42}'
{"quads":[[10,20,110,20,110,40,10,40]]}
```

Only the methods an agent needs to read and drive a page go through:
`Accessibility.getFullAXTree`, `getPartialAXTree` and `queryAXTree`;
`DOM.focus`, `getBoxModel`, `getContentQuads` and `scrollIntoViewIfNeeded`;
`Input.dispatchKeyEvent`, `dispatchMouseEvent` and `insertText`; and `Page.captureScreenshot`,
`getLayoutMetrics`, `getNavigationHistory`, `navigate` (to http and https
only), `navigateToHistoryEntry` and `reload`. Nothing reads cookies or
storage or runs script. Private windows and native windows are refused, and
so is navigating or reloading the shell's page. A page
that does not answer in 10 seconds is refused too.

## `domicile screen-record`

Open the shell's screen cast picker and record what is picked, with its sound,
until the toolbar's Stop. The video goes in `Videos/Screen recordings` and its
path is printed. Exits 1 if it is dismissed or discarded.

## `domicile trace [--seconds <n>] <file>`

Record the engine's trace events for 20 seconds, or `n`, to a Perfetto trace
at `file`. Open it at [ui.perfetto.dev](https://ui.perfetto.dev).

- Covers frame production: the shell and pages (`cc`, `blink`), the display
  compositor and GPU (`viz`, `gpu`), page flips (`drm`), input, and the
  DevTools frame timeline.
- Waits 31 seconds first for the engine's processes to attach, then records.
  Do what is slow while it records.
- Runs Perfetto's `traced` as you on a socket beside the control socket, where
  every engine reports. It ships in `libexec/domicile/perfetto`;
  `DOMICILE_PERFETTO` names another install (holding `bin/traced` and
  `bin/perfetto`).

```sh
domicile trace switch.pftrace
```

## `domicile set-log-level [<level> [<subsystem>...]]`

Log at `level` (`error`, `warn`, `info`, `debug` or `trace`) until the desktop
restarts: for the subsystems named, or for everything with none. With nothing,
print the levels set; with `--reset`, go back to the starting ones.

- The compositor and every engine process change at once. A part that
  restarts keeps the levels.
- The subsystems are `input`, `displays`, `windows`, `rendering`, `cast`,
  `portals`, `idle`, `clipboard`, `notifications`, `electron`, `agents`,
  `shell` and `session`. [Logs](LOGGING.md#levels) says what each covers.

```sh
domicile set-log-level trace input
domicile set-log-level --reset
```

## `domicile logs [--follow]`

Print what every part of the desktop logged since it started.

- On the journal, it runs `journalctl` for the desktop's names this boot, and
  `--follow` (or `-f`) keeps printing new lines.
- Off the journal, it prints the newest 10,000 lines the desktop kept. Those
  went to the terminal or file it started with, so follow them there.

```sh
domicile logs --follow
```

## `domicile export-logs [--show-everything] [<file>]`

Write the desktop's logs to one text file to attach to a bug report, with its
version, shell, log levels, displays and inputs. Without a file, it writes
`domicile-logs-<time>.txt` in the current directory. Prints the file's path.

- Web addresses and the open windows' titles are hidden, since they say what
  someone was doing. `--show-everything` leaves them in. The desktop's own
  `domicile://` addresses stay.
- On the journal, it holds this boot's newest 20,000 lines; off it, the
  desktop's newest 10,000.
- Exports even when the compositor is down. Window titles cannot be read then,
  so it warns that they may show.

```sh
domicile export-logs
domicile export-logs --show-everything ~/bug.txt
```

## `domicile send-shell <word>...`

Run a shell command, as a keybinding bound to it does:
`domicile send-shell workspace 2`. Manganese's commands are in
[KEYS.md](/packages/manganese-window-management/docs/KEYS.md#commands), and
`list-shell-commands` prints whichever shell is running's. It fails, with the
shell's reason, when no page listens for commands, when every page refuses
the command (an unknown command or a wrong argument), or when none says it ran
it within a second.

A command may answer, and `send-shell` prints the answer. Manganese's queries
answer with JSON, as `swaymsg -t get_workspaces` and `get_tree` do:

```
domicile send-shell get-workspaces | jq '.[] | select(.visible) | .name'
domicile send-shell get-tree
```

## `domicile list-shell-commands [--json]`

Print the commands `send-shell` takes, as the running shell describes them,
each with what it does. `send-shell --help` prints the same.

```
focus left|right|up|down  Move focus to the neighboring window.
workspace <name>          Show workspace <name>, creating it if needed.
```

A shell describes its commands when it listens for them (`bindKeys`'s
`commands`; see
[WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md)). `--json` prints the array of
`{usage, description}` instead, for scripts.

## `domicile list-bindings [--json]`

Print the running shell's keys and gestures in each binding mode, and what
each runs.

```
default
  Meta+Left    send-shell focus left
  Meta+r       mode resize

resize
  Escape       mode default
```

Chords are in one spelling (`Shift+Meta+l` prints as `Meta+Shift+l`).
`--json` prints the array of `{mode, chord, action}` instead, for scripts.

## `domicile theme [light|dark|toggle]`

Set the theme until the desktop restarts, or print it. Set `theme.mode` in
the config to keep one.

## `domicile sleep-displays [display]`

Turn every monitor off now. Windows, workspaces and the layout stay as they
are, and programs keep running. A key, a click or a pointer move lights them
again, as does `wake-displays`. Input in the first second is ignored, so
letting go of Enter or of the keybinding that ran it does not undo it. In
manganese, bind `exec domicile sleep-displays`.

With a display, by any name a profile matches it by (its connector `eDP-1`,
its panel `BOE NE135A1M-NY1`, or its output name `drm-12345`), turn only that
one off. A name no display, or more than one, answers to fails, listing every
display's names. It keeps its windows and workspace, the pointer does not
enter it, and it stays off through input until `wake-displays` names it or
names none. See
[IDLE.md](IDLE.md#sleeping-on-demand).

## `domicile wake-displays [display]`

Turn the monitors back on, after `sleep-displays` or idle blanking, or only
the display named. For a script, or over SSH.

## `domicile list-displays [--json]`

Print each display: every name `sleep-displays` and a display profile take for
it, its mode, its size and position in logical pixels, scale, rotation, HDR,
adaptive sync, and whether it is lit or off.

```
drm-1 (lit)
  names     drm-1, eDP-1, BOE NE135A1M-NY1
  mode      2256x1504 @ 59.999 Hz
  layout    1128x752 at 0,0, scale 2, normal
  color     HDR unsupported, adaptive sync off
```

`--json` prints a JSON array instead, for scripts: each display's fields as
shells get them in `domicile.displays`, plus `names` and `lit`.

## `domicile configure-display <display> <change>...`

Change a monitor until the desktop restarts, like `swaymsg output`: the
config file is left alone, and editing it later keeps these changes over it.
The display is any name `list-displays` prints or a profile matches. The
changes, in any order:

- `mode <W>x<H>[@Hz]`: a mode the monitor offers, like `2560x1440@144`.
- `scale <S>`: like `1.25`.
- `position <X>,<Y>`: its top-left corner in logical pixels, like `1920,0`.
- `transform normal|90|180|270`: content turned counterclockwise, as in a
  profile.
- `adaptive-sync on|off`, `hdr on|off`, `sdr-white <nits>`.
- `enable` or `disable`: light it, or turn it off and leave it out of the
  desktop.
- `reset`: drop this monitor's earlier changes, back to the config. Changes
  after it on the same line still apply.

```sh
domicile configure-display DP-1 mode 2560x1440@144 scale 1.25 position 1920,0
domicile configure-display eDP-1 disable
domicile configure-display eDP-1 reset
```

It changes the profile that matches the plugged-in monitors, as
[DISPLAYS.md](DISPLAYS.md) describes. With no matching profile, it starts one
of every plugged-in monitor at its defaults. A change that makes a profile the
config would refuse, such as turning off the last monitor, is refused and
changes nothing. A config that describes the desktop with `output.displays`
sets its monitors there, so this refuses them.

## `domicile list-windows [--json]`

Print each window: native windows in the order they opened, then the browser
and app windows.

```
ID                                KIND     APP    PID   SIZE     TITLE
kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA  native   emacs  4242  640x480  notes.org (focused)
Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE  browser  mail   -     -        Inbox (private)
```

- `ID` is the window's `ext-foreign-toplevel-list-v1` identifier, which
  capture tools see too.
- `APP` is a native window's desktop entry id, or an app window's id.
- `focused` marks the native window with the keyboard. The shell's page holds
  the keyboard for browser windows, so none is marked.
- `urgent` marks a window that asked for the keyboard and was refused.
- `private` marks a private browser window.

`--json` prints a JSON array instead, for scripts, with `kind`, `title`,
`app`, `pid`, `size`, `focused`, `urgent`, `url` (a browser window's address,
`null` for a native window), `private`, `engine_id` (a browser window's
id in the engine, `null` for a native window) and `views` per window.
`views` lists the views a browser window holds and shows, bottom first: an
Electron app's `WebContentsView`s, each with its `id` and its `position` and
`size` in the window's page, in CSS pixels.

## `domicile list-inputs [--json]`

Print each keyboard, pointer and touch device the desktop reads, in the order
it found them.

```
ID  KIND         CONNECTION  VENDOR:PRODUCT  NAME
4   keyboard     internal    0001:0001       AT Translated Set 2 keyboard
9   mouse        bluetooth   046d:4082       Logitech MX Master 3
11  touchpad     internal    -               SYNA8004:00 06CB:CD8B Touchpad
```

- `ID` holds while the device stays plugged in. A device that is two kinds,
  like a keyboard with a touchpad, is one row per kind under one id.
- `KIND` is `keyboard`, `mouse`, `touchpad`, `touchscreen`, `pointing-stick`,
  `tablet`, or `other` for one read only for its keys or switches, like a
  power button.
- `CONNECTION` is `internal`, `usb`, `bluetooth` or `unknown`.
- `VENDOR:PRODUCT` are its USB or Bluetooth ids, as `lsusb` prints them, or
  `-` when it has none.

`--json` prints a JSON array instead, for scripts, with `id`, `name`, `kind`,
`connection`, `sys_path` (its device under `/sys`, or empty), `vendor` and
`product` per device.

## `domicile lock`

Lock the desktop now, as its lock timeout does. The compositor owns the lock,
so this works with any shell that draws a lock screen.

## `domicile focus-window <id>`

Ask the shell to show and focus the native window `id`, as `list-windows`
prints it. This is the request a window makes for itself when it wants
attention, so the shell decides: Manganese switches to its workspace.

## `domicile close-window <id>`

Ask the native window `id` to close, as its close button does. The app may
ask first, for example about unsaved work.

## `domicile kill-window <id>`

Kill the process of the native window `id` with `SIGKILL`, for an app that no
longer answers. Every window of that process goes with it, and for an X11 app
that is `xwayland-satellite` and every X11 window.

`focus-window`, `close-window` and `kill-window` take only native windows.
The shell shows and closes browser windows.

## `domicile exec <program> [<arg>...]`

Start a program as the desktop starts apps: with the desktop's environment, in
its own scope, without a shell. A `<program>` with no `/` is found on the
desktop's `PATH`. Fails saying why when it does not start, such as a program
not on that `PATH`.

```
domicile exec kitty --hold btop
```

Every shell gets it; nothing about it is the shell's. A shell's own starts, such
as a keybinding's `KeyAction.Exec`, that fail tell the person in a
notification.

## `domicile inhibit-idle -- <command>...`

Run a command and keep the screens on, and the desktop unlocked, until it
exits, like `systemd-inhibit --what=idle`. It exits as the command does.

```
domicile inhibit-idle -- rsync -a ~/photos backup:photos
```

The shell lists the command's program among what holds the desktop awake, as
`status` does. `--` is optional unless the command's own first word starts
with `-`.

## `domicile subscribe [windows|displays|inputs|status]...`

Print what `list-windows --json`, `list-displays --json`, `list-inputs --json`
and `status --json` would, as one JSON line each, then a topic's line again
whenever its answer changes, until stopped. With no topic, every one.

```
$ domicile subscribe windows | jq -c '.windows | map(.title)'
["notes.org"]
["notes.org","Inbox"]
```

Each line is the compositor's message, its `type` saying which topic it
answers: `window_list` (with `windows`), `display_list` (`displays`),
`input_list` (`inputs`) or `status` (the fields of `status --json`'s
`status`). A line is sent only when it differs from the last for its topic.
Most changes arrive at once; what holds the screens on or captures the
desktop may take up to five seconds. It ends when the desktop does.

## `domicile status [--json]`

Print how the desktop is: the shell it serves, theme, keymap, whether it is
locked, whether the screens are off, what keeps them on (idle inhibitors), and
what records or controls it (screen casts, recordings, remote desktop, input
capture).

```
shell       /nix/store/…/shell.js
theme       dark
keymap      dvorak
locked      no
screens     lit
held awake  Firefox
capturing   -
```

`--json` prints `{"shell": …, "status": {…}}` instead, for scripts.

## `domicile idle-time [--json]`

Print how many whole seconds nobody has used the desktop: since the last key,
pointer, touch or tablet input, or since the desktop started when there has
been none. Idle inhibitors don't reset it. Electron apps read it for
`powerMonitor.getSystemIdleTime`, so Slack and the like can mark you away.

```
42
```

`--json` prints `{"seconds": 42}` instead.

## `domicile disable-while-typing [on|off|toggle]`

Set whether a touchpad ignores the pointer while you type, or print it. On by
default, and on again when the desktop restarts. A desktop in a window
refuses it: the host reads the touchpad.

## `domicile monitor <name> <W>x<H>[@Hz] [scale]`

Add a monitor with no screen, like a pane of another program the desktop is
shown in, and print its output (`virtual-1`). Each line read from stdin,
like `1024x768` or `1024x768@30`, resizes it in place: its windows stay. It
is removed when stdin ends. Exits 1 if the desktop takes it away first. Only a
desktop on a tty or headless has monitors to add to
([A-HEADLESS-DESKTOP.md](architecture/A-HEADLESS-DESKTOP.md)). 60 Hz and
scale 1 unless given. A line may give a scale too, like `3840x2160 2`.

## `domicile power-off`

Ask in Domicile's dialog, then turn the computer off.

## `domicile reboot`

Ask, then restart the computer.

## `domicile log-out`

Ask, then end the login session.

## `domicile mcp`

Serve the [Model Context Protocol](https://modelcontextprotocol.io) on stdin
and stdout, so an agent can drive the running desktop. Add it to Claude Code
with:

```
claude mcp add domicile -- domicile mcp
```

The first tool call asks you, in Domicile's dialog, to let the agent in,
named as its client names itself: your entire desktop, or only the windows you
check. Until you answer, the call waits; a minute without an answer counts as
Cancel. While it's in, the bar shows it and what it did last, and Stop there
ends it. Every call after is checked against what you allowed:

- **Entire desktop**: every tool.
- **Only these windows**: `list_windows` lists only those windows, and
  `close_window` and the browser and app tools work on them alone. The tools
  that reach the whole desk (screenshots, the pointer and keyboard, `open`,
  `send_shell`, `exec`, `focus_window`, `theme` and the other listings) are refused.
  Private browser windows are never offered.

An agent you cancel or stop is refused from then on, until it calls
`ask_to_use_desktop`, which asks again, or its next session does. After a stop
it asks even when remembered. If you turn on **Remember** with the entire desktop, it comes in
without asking until you forget it in Settings › Agents or with
`forget-agent`. **Change** in the bar asks again; what you pick applies from
the agent's next call. See [AGENTS.md](AGENTS.md).

Each tool runs a verb and answers what it printed, or its error:

| Tool | Runs |
|---|---|
| `list_windows`, `list_displays`, `list_inputs`, `status`, `list_shell_commands`, `list_bindings` | that verb with `--json` |
| `send_shell` | `send-shell <words>...` |
| `exec` | `exec <argv>...` |
| `open` | `open [--app] [--profile <id>] <target>` |
| `focus_window`, `close_window` | that verb with the window's id |
| `theme` | `theme [light\|dark\|toggle]` |
| `screenshot` | `screenshot --fit 1280 [--area <area>] <file>`, answered as the PNG; `area` zooms into part of the last screenshot |
| `click`, `move_pointer` | `pointer`, with the point scaled from the last screenshot's pixels to the desk's |
| `drag` | `drag`, with both points scaled the same way |
| `scroll` | `pointer`, then `scroll` |
| `key`, `type_text` | `key <chord>`, `type <text>` |
| `browser_snapshot` | `devtools <window> Accessibility.getFullAXTree`, then the same for each view the window holds, answered as an outline of the page and each view, one element a line with its ref. A view's refs are `<view>:<element>` |
| `browser_click` | `devtools` scrolling the element into view, finding its box, and clicking its middle |
| `browser_type` | `devtools` focusing the element, if given a ref, then `Input.insertText` |
| `browser_key` | `devtools` pressing and releasing Enter, Tab, Escape, an arrow or another named key |
| `browser_navigate` | `devtools <window> Page.navigate` |
| `browser_screenshot` | `devtools [--view <view>] <window> Page.captureScreenshot`, answered as a WebP |
| `app_snapshot` | `accessibility <window>` |
| `app_click`, `app_focus`, `app_set_text` | `accessibility-act <window> <ref> click\|focus\|set-text <text>` |
| `ask_to_use_desktop` | nothing: asks the user again, after they stopped the agent or turned it away |
| `stop_using_desktop` | nothing: ends the agent's session, as **Stop** does, so its next call asks again |

The browser and app tools work on a window the desk hides and need no screenshot, so prefer them for browser windows and for native apps that support accessibility. The browser tools reach the shell's own bars, panels and dialogs as window `shell`, with the entire desktop. `initialize`'s instructions tell the agent so. Each browser and app act answers what it changed in the window since the agent last read it, or all of it, read a quarter second after. An Electron app such as Claude or Slack draws its page in views: `browser_click` acts in the view its ref names, and `browser_type`, `browser_key` and `browser_screenshot` take a `view`. Tools the lock refuses are refused while the desktop is locked.

### Over HTTP

`domicile mcp --http <address> [--url <url>]` serves the same tools over
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
at `/mcp`, for agents that connect to a URL and sign in, such as Claude Code
with `claude mcp add --transport http domicile http://127.0.0.1:7465/mcp`.
`<url>` is the address agents reach it at, if not `http://<address>`.

- **Signing in** is OAuth 2.1, served by `domicile mcp` itself: the agent
  registers and opens a page that waits while the desktop asks whether to let
  it sign in, showing the number the page shows; **Allow** lets it in, within
  two minutes. Signed-in agents are kept in
  `$XDG_STATE_HOME/domicile/signed-in-agents.json`, refresh tokens only as
  hashes, so they stay signed in when it restarts.
- **Each session asks on the desk** at its first tool call, as on stdio. A
  session ends when the agent ends it or after 30 minutes unused, which lets
  the agent go.
- Requests naming another host, or a web page's origin other than this
  server's, are refused, so a page can't reach it by renaming its own host.
- It answers each message as JSON and opens no event stream.

### Through the relay

`domicile mcp --relay [<relay>]` serves the same, signed in the same way, to
agents on the web, such as claude.ai, through Domicile's relay at
`mcp.domicile-desktop.com:7444`, or the one at `<relay>`. It prints the
address to add as a connector, `https://<label>.mcp.domicile-desktop.com/mcp`,
which stays the same as long as `$XDG_STATE_HOME/domicile/relay.json` is
kept. The desk gets its own certificate for that address, so the relay
passes the connection along without being able to read it; the first one
takes a minute or so. It writes how it is doing to
`$XDG_RUNTIME_DIR/domicile/web-agents.json`, which Settings shows. The
desktop runs it while `agents.web` is set, so this is for running it by hand.
See [AGENTS.md](AGENTS.md#agents-on-the-web).

## `domicile agent <name>`

Ask, in Domicile's dialog, to let the agent `name` see and use the desktop,
and print what you allowed as a JSON line: `{"type":"desk"}`, or
`{"type":"windows","windows":[...]}` with each window's `id`, `kind`, `title`
and `app`. A remembered agent is let in without asking. Each time you change
what it reaches from the bar, another such line follows. Each line read from
stdin is listed in the bar as what the agent did last. The agent stays in
until stdin ends. Exits 1 if you cancel, don't answer within a minute, or stop
it from the bar. `domicile mcp` runs this on its first tool call.

## `domicile list-agents [--json]`

Print the agents in now, with the session `stop-agent` takes and the windows
they reach (or `desk`), then those remembered.

```text
SESSION  STATE       REACH  AGENT
12       in          kD3m   Claude Code
-        remembered  desk   Codex
```

`--json` prints `{"connected": [{"session", "agent", "reach"}],
"remembered": [{"agent", "last_used_ms"}]}`.

## `domicile stop-agent <session>`

Stop an agent, by its `list-agents` session, as Stop in the bar does.

## `domicile forget-agent <name>`

Make a remembered agent ask again the next time it connects. Forgetting one
that isn't remembered does nothing.

## `domicile check-config <file>`

Check a config file without a desktop. Exits non-zero with the reason the
compositor would refuse it. home-manager runs it on the file it writes.

## `domicile help [command]`

Print the commands, grouped, or one command's usage, options and examples.
`--help` and `-h` do the same, also after a command, except that
`send-shell --help` prints the shell's own commands.

- `domicile help --man <dir>` writes `domicile.1` and a `domicile-<command>.1`
  for each command. The flake and the distribution packages install them, so
  `man domicile-configure-display` works.
- Help, man pages and the tests that keep `docs/CLI.md` in step come from one
  table: `packages/domicile-launch/src/commands.rs`.

## `domicile --version`

Print the version, the commit it was built from, and the engine.

```text
domicile 1.2.0
commit   144a93c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7
engine   s2ffe1826ced0, checked build of Chromium 7703634 at 246fa60eff4e, built 2026-11-15T09:12:44Z
```

- The first two lines are `libexec/domicile/version`, which the flake and the
  distribution packages write.
- The engine line is from its release's `PROVENANCE`.
- A missing file fails, naming it.

Any other flag before or after a shell is refused rather than taken as the
shell.

## Output

- **Color** only on a terminal, and never with `NO_COLOR` set or `TERM=dumb`.
  It uses the terminal's 16 colors, so its theme picks the shades.
- **Errors** go to stderr as `error: <why>`. A refused command line also
  prints the command's usage.
- **`--json`** output never changes with the terminal. Scripts read it, not
  the tables.
- A typo of a command, such as `domicile wndows`, is refused with the command
  it likely meant, unless a file of that name exists.

## While locked

`screenshot`, `screen-record`, `send-shell`, `focus-window`, `close-window`,
`kill-window`, `exec`, `pointer`, `drag`, `scroll`, `key`, `type`, `devtools`, `accessibility`,
`accessibility-act`, `agent`, `list-agents`, `stop-agent` and `forget-agent`
are refused while the desktop is locked, as is adding a `monitor`. `theme`, `sleep-displays`,
`wake-displays`, `lock`, `inhibit-idle`, `list-displays`, `list-windows`,
`list-inputs`, `status`, `idle-time`, `subscribe`, `configure-display`,
`list-shell-commands` and `list-bindings` work, and a `monitor` added before keeps resizing.

## Environment

`DOMICILE_ENGINE_ARGS` adds switches to the browser engine
([RUNNING-A-DESKTOP.md](RUNNING-A-DESKTOP.md#engine-flags)).
