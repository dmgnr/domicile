# The config file

One JSON file (or a module that builds it) describes a desktop: displays,
input devices, idle, lock, lockdown, theme and extensions. The compositor reads it at startup
and reloads it on every change. The schema is the `domicile-config` crate's.

For what a shell does with these settings, see
[WRITING-A-SHELL.md](WRITING-A-SHELL.md). The Settings app edits the file
([SETTINGS.md](SETTINGS.md)).

## Where it is

- `domicile --config ./desk.json ./my-desktop/dist/shell.js` names it. The flag
  can go before or after the shell.
- Without the flag, `domicile` looks for
  `$XDG_CONFIG_HOME/domicile/domicile.{ts,tsx,js,mjs,json}` (or
  `~/.config/domicile/` if `XDG_CONFIG_HOME` is unset). Two matches is an
  error.
- With no config file, the compositor uses its defaults: one output that
  follows the engine's window (suits a nested dev run).
- `--config` with no value, or given twice, is an error.
- `domicile` prints which config it used before starting:

```
config: /home/you/.config/domicile/domicile.json
config: ./desk.json, because --config names it
config: none -- no domicile.{ts,tsx,js,mjs,json} in /home/you/.config/domicile -- so the compositor's defaults
```

`domicile-compositor` itself reads nothing from the environment. It takes every
value on its command line. The lookup above is the `domicile` binary's.

## A config module

A `.ts`, `.tsx`, `.js` or `.mjs` config is evaluated to JSON.

- The `Shell` export is the shell to run when none is given.
- In a JSON config, name the shell with `"shell"`, relative to the config
  file: `{ "shell": "@domicile-desktop/manganese" }`.
- An `options` export is the shell's declared options
  ([WRITING-A-SHELL.md](WRITING-A-SHELL.md#options)), not a section.
- Every other export is a top-level section of the schema. Keybindings are
  shell props, so a `keybindings` or `modes` export is an unknown section and is
  rejected.

```tsx
// ~/.config/domicile/domicile.tsx
import { runManganese } from "@domicile-desktop/manganese";
import type { InputConfig } from "@domicile-desktop/sdk/config";

export const input: InputConfig = { keyboard: { xkb_variant: "dvp" } };
export const Shell = runManganese();
```

- Styling custom manganese bar items:
  [CUSTOM-BAR-ITEMS.md](/packages/shell-manganese/docs/CUSTOM-BAR-ITEMS.md).
- `@domicile-desktop/*` and React resolve to the running Domicile's copies,
  whatever `package.json` says. Building it:
  [SHELL-PACKAGING.md](SHELL-PACKAGING.md#distributing).
- How it is evaluated:
  [THE-DOMICILE-BINARY.md](/docs/architecture/THE-DOMICILE-BINARY.md#config-modules).

## Types and schema

- `@domicile-desktop/sdk/config` has a type for each section (`InputConfig`,
  `OutputConfig`, …) and `Config` for the whole file.
- `@domicile-desktop/sdk/config.schema.json` is the JSON Schema. A JSON config
  names it for editors, and the compositor ignores the key:
  `{ "$schema": "https://domicile-desktop.com/config.schema.json" }`. That copy
  is built from the commit these docs are, so it matches them. The SDK's copy
  matches the SDK version you installed.
- Both are generated from `domicile-config`'s Rust types; see the SDK's
  [Generated types](/packages/chrome-sdk/README.md#generated-types).

## Home-manager

`programs.domicile` has an option for every schema field:

```nix
{
  imports = [domicile.homeManagerModules.default];

  programs.domicile = {
    enable = true;
    shell = "${domicile.packages.${system}.manganese}/shell.js";
    settings.output.profiles = [{
      name = "desk";
      displays = [
        {display = "DEL DELL U3219Q 2ZLS413"; scale = 1.2; transform = "rotate-270";}
      ];
    }];
  };
}
```

- It writes the config to the standard path and puts `domicile` on `PATH`
  with your shell set.
- It installs no login session. That is the NixOS module's job
  ([RUNNING-A-DESKTOP.md](/docs/RUNNING-A-DESKTOP.md#the-machines-half)).
- `settings` is freeform, so keys newer than the module pass through.
- The build runs `domicile check-config` on the file, so a key the compositor
  refuses fails `home-manager switch` instead of the desk. Run it yourself on
  a hand-written config: `domicile check-config ~/.config/domicile/domicile.json`.
- `configDirectory` builds a config module at `home-manager switch`:

  ```nix
  programs.domicile.configDirectory = ./domicile;
  ```

  - The directory holds one `domicile.{ts,tsx,js,mjs}`, its `package.json`
    and `bun.lock`, and a `bun.nix`. Write `bun.nix` with
    `bunx bun2nix -o bun.nix` after each change to `bun.lock`.
  - Every package the config imports must be in `bun.lock`. The build has no
    network, so it cannot add one.
  - Exports are written over `settings`; `settings` fills in the rest.
  - `Shell` is bundled into the store and becomes `shell`.
- `webApps` installs sites as apps. Each gets a desktop entry that runs
  `domicile open --app <url>` ([WEB-APPS.md](/docs/architecture/WEB-APPS.md)):

  ```nix
  programs.domicile.webApps.Music = {
    url = "https://music.example/";
    icon = "multimedia-audio-player"; # an icon theme name or a file
  };
  ```

## Reloading

An edit applies to the running desktop, and windows stay open:

| Section | Effect of an edit |
|---|---|
| `input.keyboard.repeat` | Native windows and pages repeat held keys at the new delay and rate |
| `input.keyboard` | New layout; moves the keys a shell bound ([Keybindings](WRITING-A-SHELL.md#keybindings)). The desktop stays on the active keymap if `keymaps` still names it, else goes to the first |
| `input.touchpad`, `input.mouse` | Settings applied to attached devices and retained for later attachments |
| `input.pointers` | Tablets, touchscreens and absolute mice rebound |
| `output.max_scale` | Re-advertised to clients |
| `output.displays`, `output.profiles` | Displays rearranged |
| `idle.blank_after_seconds`, `idle.lock_after_seconds` | Idle timer restarts. Dark screens relight |
| `theme.mode` | Shell and windows repaint |
| `theme.accent_color`, `contrast`, `reduced_motion` | Shell and windows that read the settings portal follow |
| `theme.cursor_theme`, `cursor_size` | The pointer on a tty is redrawn; windows that read the settings portal follow |
| `theme.cursor_hide_after_ms`, `cursor_hide_when_typing` | The pointer is shown, and hides by the new settings |
| `theme.font_name`, `monospace_font_name` | Windows that read the settings portal follow |
| `theme.force_dark` | Those sites are drawn dark from their next load |
| `theme.icon_theme` | Shell and windows that read the settings portal follow; tray icons redrawn and later notifications drawn in it; manganese on the next menu or launcher opening, and title bars when a new app id appears |
| `spellcheck` | Text fields check spelling in the new languages, or stop |
| `files.omit` | Launcher file index rebuilt |
| `electron.apps` | Starting a newly listed app runs it on the engine; apps already running stay as they are |
| `extensions` | Extensions installed or removed ([EXTENSIONS.md](/docs/architecture/EXTENSIONS.md)) |
| `lockdown` | Applications told through the Lockdown portal |
| `terminal` | Processes started from then on get the new terminal: the launcher's next opening, the next `domicile open` from a new window, and Meta+Return |
| `lock` | The next passphrase is checked through the new PAM service. The desktop never unlocks from a reload ([LOCK.md](LOCK.md#reloading)) |

- A config module is watched with its directory, except `node_modules` and
  dot directories. An edit re-evaluates it and, if it is the shell, rebuilds
  and reloads the shell. A reload during an engine restart waits for the
  engine. A failure is logged, posted as a notification, and leaves the
  desktop as it was.
- `startup` is read only at startup. Rerunning it would duplicate its
  commands.
- A file that fails to parse is rejected and logged. The last good config
  stays.
- A keyboard xkb cannot compile, any of its keymaps included, is rejected
  and logged. The current layout stays.
- A `lock.pam_service` the machine does not declare is taken, and logged:
  the desktop does not lock until the file is added
  ([LOCK.md](LOCK.md#failures-fail-closed)).

## Other sections

- `shell_options`: values for the options the shell declares, by key. The
  compositor passes them to the shell without reading them. See
  [WRITING-A-SHELL.md](WRITING-A-SHELL.md#options).
- `startup.commands`: commands run once when the compositor starts. Each is an
  argv: `[["emacs", "--daemon"], ["sh", "-c", "…"]]`.
- `files`: what the launcher's file index leaves out. See
  [LAUNCHER.md](LAUNCHER.md).
- `electron.apps`: desktop file ids of installed Electron apps that run on
  the desktop's engine instead of the Electron they ship:
  `{ "electron": { "apps": ["slack.desktop"] } }`. Whatever starts the
  entry (the launcher, a link, a notification) runs it with
  `domicile open --electron`. An entry in `~/.local/share/applications`
  can't be overridden, and is logged. See
  [ELECTRON-APPS.md](architecture/ELECTRON-APPS.md).
- `browser`: browser profiles and the profile each site opens in. Each
  profile has its own sign-ins, site data and extensions, and a private one
  keeps nothing past its last page. A page the user takes to a listed site
  moves to its profile; see
  [BROWSER-PROFILES.md](architecture/BROWSER-PROFILES.md).
- `terminal`: see [Terminal](#terminal).
- `output.max_scale`: the highest scale advertised for the output that
  follows Domicile's window. Applies only when `output.displays` is empty.
  Default `2`; `1` turns scaling off.

## Terminal

Applications such as htop and vim run in a terminal (`Terminal=true` in their
desktop entries). Domicile has no default terminal, so they are offered only
when the config names one:

```json
{ "terminal": ["kitty"] }
```

- It is an argv. Run alone, it opens a terminal; with an application's argv
  after it, it runs that application in one. `["kitty"]` and `["foot"]` work
  as written; `["alacritty", "-e"]` needs its `-e`, so Meta+Return opens
  nothing with it. Prefer one that opens a shell when given nothing to run.
- With it set, the launcher lists those applications and offers them under
  "Open with", and `domicile open` runs them for the types they open. Vim
  opening `a.txt` runs `kitty vim a.txt`.
- Manganese opens it on Meta+Return.
- Unset, those applications are left out, as before, and Meta+Return does
  nothing.
- The compositor passes it to every process it starts as `DOMICILE_TERMINAL`,
  a JSON array. That is how the launcher and `domicile open` see it.

## Keyboard

`input.keyboard` takes sway's `xkb_*` fields: `xkb_layout`, `xkb_variant`,
`xkb_options` and the rest. The default is plain `us`, no variant, no options.
A shell for users of other layouts must set them here; nothing else does.

To switch between layouts, list them in `keymaps` instead:

```json
{
  "input": {
    "keyboard": {
      "keymaps": [
        { "name": "dvp", "xkb_variant": "dvp", "xkb_options": ["caps:escape"] },
        { "name": "us" }
      ]
    }
  }
}
```

- Each entry is a whole keymap with the same `xkb_*` fields and defaults. It
  takes nothing from the fields beside `keymaps`, which must stay unset.
- `name` is what the shell shows and selects. Each is unique, and none is
  `next`. A keyboard without `keymaps` is one keymap, named for its variant,
  or its layout when it has none.
- The desktop starts on the first. A switch reaches every window, the
  browser and the shell's keybindings, and lasts until the desktop
  restarts.
- A shell lists them, each with xkb's name for its layouts (such as
  `English (programmer Dvorak)`), with `domicile.keyboard.keymaps()` and
  switches with
  `keyboard.selectKeymap()` ([SHELL-SYSTEM-ACCESS.md](SHELL-SYSTEM-ACCESS.md)). Both
  work while locked.

`repeat` sets how a held key repeats, in native windows and in pages:

```json
{ "input": { "keyboard": { "repeat": { "delay_ms": 300, "rate": 30 } } } }
```

- `delay_ms` is how long a key is held before it repeats. The default is 500.
- `rate` is repeats a second. The default is 25; 0 turns repeat off.
- Pages follow it on a tty. Nested, the host desktop repeats keys for pages.

## Touchpads and mice

`input.touchpad` and `input.mouse` configure devices on a tty. The mouse section
covers relative mice and pointing sticks. A nested desktop uses its host
compositor's settings. Each section applies to every device of
that kind, including Bluetooth reconnections and devices reopened after a
console switch. Edits apply without an engine restart; removing a setting
restores its default.

```json
{
  "input": {
    "touchpad": {
      "natural_scroll": true,
      "click_method": "clickfinger",
      "scroll_method": "two_finger",
      "scroll_acceleration": false,
      "disable_while_typing": "libinput"
    },
    "mouse": { "accel_profile": "flat" }
  }
}
```

| Key | Values | Default |
|---|---|---|
| `touchpad.tap` | Tap to click | `true` |
| `touchpad.tap_button_map` | `"lrm"`, `"lmr"`: buttons for one-, two- and three-finger taps | `"lrm"` |
| `touchpad.tap_drag` | Tap, then hold a second tap to drag | `true` |
| `touchpad.drag_lock` | Hold a tap drag across a brief finger lift | `false` |
| `touchpad.natural_scroll`, `mouse.natural_scroll` | Reverse scroll direction | `false` |
| `touchpad.accel_profile`, `mouse.accel_profile` | `"adaptive"`, `"flat"` | `"adaptive"` |
| `touchpad.speed`, `mouse.speed` | Pointer acceleration speed, from `-1` to `1` | `0` |
| `touchpad.click_method` | `"default"`, `"clickfinger"`, `"button_areas"` | `"default"` |
| `touchpad.middle_emulation`, `mouse.middle_emulation` | Left and right together produce a middle click | `false` |
| `touchpad.scroll_method` | `"default"`, `"two_finger"`, `"edge"`, `"on_button_down"` | `"default"` |
| `touchpad.scroll_factor`, `mouse.scroll_factor` | Positive scroll-distance multiplier, applied once to both axes | `1` |
| `touchpad.scroll_acceleration` | Increase page scroll distance with gesture speed, up to four times | `true` |
| `touchpad.disable_while_typing` | `"enabled"`, `"disabled"`, `"internal"`, `"libinput"` | `"enabled"` |
| `touchpad.typing_pause_ms` | Pause after one typing key, from `0` to `2147483647` milliseconds | `200` |
| `touchpad.typing_repeat_pause_ms` | Pause during continued typing, in the same range | `500` |

- `default` selects libinput's default for each device. Clickfinger assigns
  left, right and middle to one-, two- and three-finger physical clicks.
- A device applies the settings it supports. Unsupported capabilities are
  reported in the engine log.
- `scroll_acceleration` applies to pages only. Native apps always get
  libinput's distance times `scroll_factor`, because they run their own
  momentum scrolling.
- `scroll_acceleration: false` with `scroll_factor: 1` preserves libinput's
  scrolling distance, as in Sway. The multiplier is independent of pointer
  speed and acceleration.
- `disable_while_typing: "libinput"` uses libinput's native keyboard pairing,
  contact tracking and physical button handling, as in Sway. It applies to
  touchpads with native typing suppression; external pads such as a Magic
  Trackpad normally remain available. The two pause fields must keep their
  defaults, `200` and `500`, because libinput owns its timers.
- The custom `enabled` and `internal` modes use configurable pauses. `enabled`
  covers every touchpad; `internal` excludes external pads. Any keyboard can
  trigger them. Each pause can be zero. Another typing key within 200 ms or
  during an active pause uses `typing_repeat_pause_ms`.
- Changing touchpad or mouse settings clears custom pauses and typing history.
  Native libinput contact state survives reload; a suppressed contact can stay
  suppressed until it lifts. See
  [Disable while typing](RUNNING-A-DESKTOP.md#disable-while-typing) for typing
  shortcuts and held drags in the custom modes.
- `domicile disable-while-typing` overrides the enabled state until a touchpad
  or mouse settings edit, or an engine restart, restores the config.

## Tablets and touchscreens

On a tty, `input.pointers` binds each tablet, touchscreen or absolute mouse
(such as QEMU's USB tablet) to the display it covers. An unbound touchscreen
covers the only display when there is one, such as a laptop's own screen, and
no display when there are several. An unbound absolute mouse covers the
display the pointer is on.

```json
{
  "input": {
    "pointers": [
      { "device": "usb-0000:00:04.0-1/input0", "display": "Virtual-1" },
      { "device": "usb-0000:00:04.0-2/input0", "display": "Virtual-2" }
    ]
  }
}
```

- `device` is the evdev name or `phys`, matched exactly. A name binds every
  device that has it, so tell identical tablets apart by `phys`.
  `udevadm info /dev/input/eventN` prints both.
- `display` names a display as a profile does
  ([Naming a display](#naming-a-display)). QEMU's heads are `Virtual-1` and
  so on only with `edid=off` on the `virtio-gpu` device; otherwise they have
  an EDID description.
- Details: [DISPLAYS.md](DISPLAYS.md#tablets-and-touchscreens).

## Agents

```json
{ "agents": { "web": true } }
```

`agents.web` lets agents on the web, such as claude.ai, reach the desktop
through Domicile's relay. While it is `true`, the compositor runs `domicile
mcp --relay`, and runs it again if it exits; setting it back to `false`
stops it. Each agent still signs in only once you allow it on the desktop,
and asks before it uses anything. Defaults to `false`. Settings › Agents › Connect
from the web sets it ([AGENTS.md](AGENTS.md#agents-on-the-web)).

## Idle

`idle.blank_after_seconds` is how long the desktop goes without input before
the screens turn off. Any key, click, scroll or pointer motion turns them back
on. `idle.lock_after_seconds` is how long before it locks.

- Unset means the screens never blank. `0` is an error.
- A shell that dims or counts down before blanking chooses when itself
  ([SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#acting-before-blanking)).
- `idle.lock_after_seconds` runs on its own clock from the same input, so it
  may be shorter or longer than `blank_after_seconds`. Unset means no lock on
  idle; the desktop still locks when the shell asks and before the machine
  sleeps ([Locking](SHELL-IDLE-AND-LOCK.md#locking)). `0` is an error.
- Apps can block blanking and locking (for example, during a video) with
  `zwp_idle_inhibit_manager_v1`. This involves only the app and the
  compositor.
- Shell side: [SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#idle).
  Implementation: [IDLE.md](IDLE.md).

## Lock

The desktop always has a lock, with or without this section. The user's
password unlocks it, checked by PAM. There is no other way to unlock it.

- `lock.pam_service`: the PAM service that checks it. Unset is `domicile`,
  which the NixOS module and the distribution packages declare. Empty, or a
  name that is not a file name in `/etc/pam.d`, is an error.
- Without `/etc/pam.d/<service>`, the desktop does not lock, since nothing
  could unlock it. [LOCK.md](LOCK.md#verifiers) says which file to add.

Shell side: [SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#locking).
Implementation: [LOCK.md](LOCK.md).

## Lockdown

```json
{ "lockdown": { "disable_camera": true, "disable_printing": true } }
```

Switches that ask applications not to do something. The compositor reports
them through the `org.freedesktop.impl.portal.Lockdown` portal; applications
that read it enforce them. Every switch defaults to `false`.

- `disable_printing`, `disable_save_to_disk`, `disable_application_handlers`
- `disable_location`, `disable_camera`, `disable_microphone`,
  `disable_sound_output`

An application that ignores the portal is not stopped.

## Theme

```json
{ "theme": { "mode": "light" } }
```

`theme.mode` is `"dark"` or `"light"`. There is no `"system"` value, because
this config is the system setting. `"system"` is rejected.

The shell's toggle and `domicile theme` change it until the desktop restarts
([RUNNING-A-DESKTOP.md](RUNNING-A-DESKTOP.md#theme)).

Applications read the rest through the settings portal
(`org.freedesktop.appearance`), and the shell receives them too:

| Key | Values | Default |
|---|---|---|
| `theme.accent_color` | `"#rrggbb"` | unset: each application's own |
| `theme.contrast` | `"normal"`, `"high"` | `"normal"` |
| `theme.reduced_motion` | `true`, `false` | `false` |
| `theme.icon_theme` | an icon theme's directory name, such as `"Papirus-Dark"` | unset: `hicolor` only |
| `theme.cursor_theme` | a cursor theme's directory name, such as `"Bibata-Modern-Ice"`, or one per mode: `{ "dark": "Bibata-Modern-Ice", "light": "Bibata-Modern-Classic" }` | unset: each application's own |
| `theme.cursor_size` | logical pixels, at least `1` | unset: each application's own |
| `theme.font_name` | a Pango font description, such as `"Inter 11"` | unset: each application's own |
| `theme.monospace_font_name` | a Pango font description, such as `"Iosevka 12"` | unset: each application's own |

`icon_theme`:

- Served as `org.gnome.desktop.interface`'s `icon-theme`. Unset leaves it to
  the next portal backend; a reload that unsets it signals `hicolor`.
- Install the theme so it is under a data directory's `icons`, such as
  `~/.local/share/icons`.
- Shells read it with `watchIconTheme` from `@domicile-desktop/sdk/icon-theme`
  and look icons up with `@domicile-desktop/system-apps/app-icons`.
- Portal dialogs draw applications in it: `describeApps` reads it each time
  a dialog's applications change.

`cursor_theme`, `cursor_size`, `font_name`, `monospace_font_name`:

- A per-mode `cursor_theme` switches with `mode`, including on the shell's
  toggle.
- Served as `org.gnome.desktop.interface`'s `cursor-theme`, `cursor-size`,
  `font-name` and `monospace-font-name`. Unset leaves each to the next portal
  backend; a reload that unsets one signals the toolkit default: `default`,
  `24`, `Sans 10`, `Monospace 10`.

The engine draws every pointer on a tty, including a window's, from
`cursor_theme` at `cursor_size`:

- Either key alone fills in the other's toolkit default. Neither draws
  Chromium's own arrows.
- The theme is looked up in `XCURSOR_PATH`, else in `$XDG_DATA_HOME/icons`,
  `~/.icons`, `icons` under each of `XDG_DATA_DIRS`, and
  `/usr/share/pixmaps`, in that order. Inherited themes are followed.
- A cursor the theme lacks is Chromium's own.
- The theme loads once per size in pixels. Until a monitor's size loads, the
  nearest loaded size stands in; before any has loaded, the pointer is
  Chromium's.
- The engine logs these at `ERROR`, which reaches the journal:
  `has no cursor for type <n>`, `no cursor theme "<theme>" on the XCursor
  path`, and `the desk names no pointer theme`. Chromium's pointer while the
  first size loads is a debug line, `the pointer is Chromium's until
  "<theme>" at <size> px loads`.
- A cursor larger than the GPU's cursor plane, often 64 or 256 pixels, is
  cut off.

The engine hides the pointer by two keys, which applications do not read:

| Key | Values | Default |
|---|---|---|
| `theme.cursor_hide_after_ms` | milliseconds without pointer input, at least `1` | unset: never |
| `theme.cursor_hide_when_typing` | `true`, `false` | `false` |

- The next pointer input shows it: a move, click, scroll, touchpad pinch or
  touchpad gesture of three or more fingers. Keys and touch do not.
- A typing key is one without Ctrl, Alt or Super held, and not a modifier,
  function, media, volume, brightness or power key. A held key repeating, or
  a key pressed during a drag, does not hide it.
- The timeout does not run while a mouse button is held.
- Hiding changes only the image: hover and the window under the pointer
  stay. It covers every monitor and screen casts, and the host's pointer
  when nested.
- Nested, the host draws the pointer from its own theme.

In manganese:

- `accent_color` replaces the `accent` token in both themes.
- `contrast: "high"` draws text at the palette's ends and darkens borders and
  muted text.
- `reduced_motion` runs every animation and transition once at the shortest
  duration: wallpaper crossfades, the theme wipe, window animations.
- `icon_theme` draws tray menu, launcher and title bar icons. Symbolic icons take the
  text's color. It is followed once per desktop; a theme that cannot be read
  is logged and drawn as `hicolor`.

Shell side: [SHELL-DESKTOP-EVENTS.md](SHELL-DESKTOP-EVENTS.md#theme).

### Sites drawn dark

```json
{ "theme": { "force_dark": ["mail.google.com"] } }
```

For sites with no dark theme of their own, such as Gmail:

- While `mode` is `"dark"`, the browser draws these sites with Chromium's
  automatic dark mode. A switch to `"light"` draws them as they are.
- Each entry is a host name. It covers its subdomains. A URL, path or port is
  rejected.
- Default: `[]`.

## Spelling

```json
{ "spellcheck": { "enabled": true, "languages": ["en-US", "de-DE"] } }
```

Text fields in pages, web apps and Electron apps underline misspelled words.

- `enabled`: default `true`.
- `languages`: language tags, default `["en-US"]`. A tag the engine has no
  dictionary for is logged and left out. An empty list is rejected; set
  `enabled` to `false` instead.
- Dictionaries ship with the engine. None is downloaded, and words are never
  sent to Google's spelling service.
- A right click on a misspelled word gives a shell the word and its
  suggestions on the context menu event. See
  [SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md#the-keyboard).


`output` has two ways to describe displays:

- **`output.displays`** lists the desktop's displays outright: name, size,
  position and scale. Use it for nested runs, where there are no monitors to
  detect.
- **`output.profiles`** arranges the monitors that are plugged in. The first
  profile whose displays are all connected applies. Matching reruns on every
  hotplug and reload.

```json
{
  "output": {
    "profiles": [
      {
        "name": "desk",
        "displays": [
          { "display": "drm-1", "enabled": false },
          {
            "display": "DEL DELL U3219Q 2ZLS413",
            "mode": [3840, 2160],
            "position": [0, 0],
            "scale": 1.2,
            "transform": "rotate-270"
          }
        ]
      },
      { "name": "laptop-only", "displays": [{ "display": "drm-1", "scale": 1.5 }] }
    ]
  }
}
```

Each profile entry sets `enabled`, `position`, a fractional `scale`, a
`transform`, and optionally `mode`, `refresh`, `adaptive_sync`, `hdr` and
`sdr_white`. An entry
without `position` goes right of the positioned ones, in profile order.

### Naming a display

Any of these match:

- the `wl_output` name: on a tty, `drm-<id>`, or the connector (`HDMI-A-1`)
  for a monitor with no EDID make, model or serial
- the connector, e.g. `DP-1` or `eDP-1`
- the EDID description `"<MAKE> <MODEL> <SERIAL>"`, e.g.
  `DEL DELL U3219Q 2ZLS413`
- the description with the maker's full name from hwdata's `pnp.ids`, e.g.
  `Dell Inc. DELL U3219Q 2ZLS413`, as kanshi and sway use

A monitor with no EDID make, model or serial has an empty description.

### `mode`

`mode` is the size to light the monitor at, in physical pixels, and `refresh`
the rate, in Hz:

```json
{
  "output": {
    "profiles": [
      {
        "name": "laptop-fast",
        "displays": [{ "display": "drm-1", "mode": [1920, 1080], "refresh": 120 }]
      }
    ]
  }
}
```

- Without `mode`, the monitor lights at its native mode.
- `refresh` picks the rate the monitor offers nearest it, at `mode` or the
  native size. Without it, a native-size monitor keeps its native rate and any
  other size gets its fastest, as in sway.
- A `mode` the monitor does not offer refuses the profile: the current layout
  stays, and the log lists the sizes it does offer.
- Positions are laid out at the requested mode, so the profile's other
  displays land where it says.

### `adaptive_sync`

`"adaptive_sync": true` turns on a variable refresh rate (adaptive sync,
FreeSync, G-Sync Compatible) for that monitor, so a frame that runs late shows
as soon as it is ready instead of waiting for the next refresh. It is off by
default.

- It is used only where the monitor, its cable and its driver support it.
- If the driver refuses it, the monitor lights the same way without it.
- The shell's `displays.list` says whether it took: `adaptiveSync` is `on`,
  `off` or `unsupported`.

### `hdr`

`"hdr": true` drives that monitor in HDR (HDR10), so HDR video and images
reach its full brightness and color. It is off by default.

- It is used only where the monitor says it takes HDR10 and its connector
  carries 10 bits a channel. Elsewhere the monitor stays SDR.
- `sdr_white` is how bright ordinary content's white is in HDR, in cd/m²
  (nits), from 1 to 10000. Without it, 203. Raise it if windows look dim next
  to the same monitor in SDR.

```json
{
  "output": {
    "profiles": [
      {
        "name": "movies",
        "displays": [{ "display": "drm-1", "hdr": true, "sdr_white": 250 }]
      }
    ]
  }
}
```

### `transform`

`transform` uses `wl_output` values, which count counterclockwise, as in
kanshi and sway. `rotate-90` is for a monitor turned a quarter clockwise;
`rotate-270` the other way.

More: [DISPLAYS.md](DISPLAYS.md) and [RUNNING-A-DESKTOP.md](RUNNING-A-DESKTOP.md).

## Extensions

See [SHELL-EXTENSIONS.md](SHELL-EXTENSIONS.md#the-config).
