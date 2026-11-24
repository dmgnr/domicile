# Keys

Manganese binds sway's keys on Meta (Super, `Mod4`) by default:
`DEFAULT_KEYBINDINGS`, in mode `default`. `runManganese({ keybindings })`
replaces them.

## Default bindings

| Keys | Action |
|---|---|
| Meta+H/J/K/L, Meta+arrows | Move focus. Wraps at the ends of a container. |
| Meta+Shift+H/J/K/L, Meta+Shift+arrows | Move the window in that direction (sway's `move`), onto the next screen past the edge. |
| Meta+1 … Meta+0 | Go to workspace 1–10. |
| Meta+Shift+1 … Meta+Shift+0 | Send the window, or the `focus parent` selection, to workspace 1–10 and stay. |
| Meta+B / Meta+V | `splith` / `splitv`: move the window out of its group, to the right / below. |
| Meta+G | `group`: turn the tab into a group of its own, nested in its slot. |
| Meta+W / Meta+S / Meta+E | `layout tabbed` / `layout stacking` / `layout toggle split`. |
| Meta+A / Meta+Shift+A | `focus parent` / `focus child`. |
| Meta+F / Meta+Shift+F | Fullscreen on this screen / on every screen. |
| Meta+Tab | `focus mode_toggle`: switch between floating and tiled windows. |
| Meta+Shift+Tab | `floating toggle`. |
| Meta+Minus / Meta+Shift+Minus | `scratchpad show` / `move scratchpad`. |
| Meta+Shift+Q | Close the window. |
| Meta+Space, Meta+D | Toggle the launcher, closing the overview. |
| Meta+O, Super tapped alone | Toggle the overview. Super held for a chord, a drag, a scroll or over 300 ms is no tap. |
| `pinch:4:inward` / `pinch:4:outward` | `overview show` / `overview hide`: open and close the overview. |
| `swipe:4:up` / `swipe:4:down` | `layer up` / `layer down`: put the scratchpad away or else open the overview / close the overview or else pull the scratchpad down. |
| `pinch:3:outward` | Toggle the launcher, closing the overview. |
| Meta+Shift+V | Toggle the clipboard history. |
| Meta+Shift+Space | Open the copied URL, or search Google for the copied text. Private from a private window. |
| Meta+Return | `terminal`: open the config's terminal. Nothing without one. |
| Meta+Shift+Return | Lock. Does nothing if the config has no `lock`. |
| Print | Take a screenshot: pick the area in the screenshot dialog. Ctrl+C there copies it instead of saving. |
| XF86AudioRaiseVolume / XF86AudioLowerVolume | Raise or lower the default output's volume by 5%, between 0 and 100%. |
| XF86AudioMute / XF86AudioMicMute | Toggle the mute of the default output / the default microphone. |
| XF86MonBrightnessUp / XF86MonBrightnessDown | Raise or lower the brightness by 5%. |

Meta+Return opens the terminal the desk's config names (`terminal`; see
[SHELL-CONFIG.md](/docs/SHELL-CONFIG.md#terminal)). It does nothing on a desk
that names none: there is no default terminal.

## Commands

Build commands with the exported helpers (`focus`, `move`, `workspace`,
`moveToWorkspace`, `grow`, `mode`, `exec`, `searchClipboard`, `volume`,
`micMute`, `brightness`, `keymap`, `notifications`, `clearNotifications`,
`idleInhibitor`, `nightLight`, `virtualMonitor`, …). `exec(...argv)` is
Domicile's `KeyAction.Exec`, not a manganese command: Domicile starts the
program, found on the desktop's `PATH`, and says so in a notification when it
can't. The rest use sway's names:

| Command | Action |
|---|---|
| `kill` | Close the window, or every window in the group `focus parent` selected. |
| `focus left/right/up/down` | Move focus. |
| `focus parent` / `focus child` | Select the enclosing container, or go back to the window. Both skip a container holding one child, such as a tab group of one window. |
| `focus mode_toggle` | Switch between floating and tiled windows. |
| `move left/right/up/down` | Move the window, or the `focus parent` selection: along its tabs, then out of its group. A window alone in its group, or a selected group, joins the next group that way as a tab. |
| `move scratchpad` / `scratchpad show` | Hide the window / show the oldest hidden one, or hide the shown one, so presses rotate through them. |
| `move container to workspace <name>` | Send the window, or the `focus parent` selection, to workspace `1`–`10`. |
| `workspace <name>` | Go to workspace `1`–`10`, or back to the previous one if it is already shown. |
| `split h` / `split v` | Move the window, or the `focus parent` selection, out of its tab group to the group's right / below it. |
| `layout stacking/tabbed/toggle split` | Set the container's layout. A split turned into tabs or a stack merges its groups; tabs turned into a split each get a group. A group already tabbed or stacking passes `layout tabbed` or `layout stacking` to the split around it. |
| `fullscreen toggle [global]` | Fullscreen on this screen, or every screen. |
| `floating toggle` | Float or tile the window. |

Manganese-only commands:

| Command | Action |
|---|---|
| `lock` | Lock the desktop. |
| `group` | Turn the focused tab into a group of its own, nested in its slot, so new windows open in it. Does nothing for a window alone in its group. |
| `launcher` | Toggle the launcher. Closes the overview. |
| `overview` | Toggle the overview: each screen's workspaces with windows, and the shown one, at once. Closes the launcher and clipboard. While it is open, `focus <way>` moves between its workspaces and `move <way>` swaps them; no other key's command runs but `lock`, `screenshot`, the volume and brightness commands, `launcher`, `clipboard`, `layer` and `overview` itself. |
| `layer up` / `layer down` | Step from the scratchpad to the desk to the overview: up runs `scratchpad hide` while a scratchpad window is out, else `overview show`; down runs `overview hide` while the overview is open, else `scratchpad bring`. Both run while the overview is open. |
| `clipboard` | Toggle the clipboard history. |
| `screenshot` | Take a screenshot, as Print does. |
| `search-clipboard` | Open the newest copy in a browser window: as a site if it is a URL, else as a search. The window is private when the active one is. Reads the first 480 characters. |
| `resize grow left/right/up/down` | Grow the window that way: a tiled window by 1/50 of its container, a floating one by 10 px. Unbound by default. |
| `volume up/down/mute` | Step the default output's volume, or toggle its mute. |
| `mic mute` | Toggle the default microphone's mute. |
| `brightness up/down` | Step the brightness. |
| `notifications` | Toggle the notification drawer, on the screen with the keyboard. Unbound by default. |
| `notifications clear` | Clear every notification, as the drawer's "Clear all" does. Unbound by default. |
| `idle-inhibitor` | Toggle keeping the screens on, as the bar's eye does. Unbound by default. |
| `night-light` | Toggle the night light, as the brightness popover's switch does. Unbound by default. |
| `virtual-monitor add [<width>x<height>]` | Add a monitor with no connector, 1920x1080 by default, which the desk extends onto. Lasts until removed or the shell reloads. Unbound by default. |
| `virtual-monitor remove` | Remove the newest virtual monitor `virtual-monitor add` added. Unbound by default. |
| `keymap next` / `keymap <name>` | Switch every keyboard to the next of `input.keyboard.keymaps`, wrapping, or to the one named. Unbound by default. |
| `shortcuts-inhibitor toggle/activate/deactivate` | Turn off, or back on, the focused window's hold on your shortcuts, as a VM or remote desktop viewer takes. Bind it with `--inhibited` so it works while the window holds them: `"--inhibited Meta+Escape": KeyAction.SendShell(["shortcuts-inhibitor", "toggle"])`. Unbound by default. |

- `mode(name)` comes from the SDK's `bindKeys`. Each monitor's page keeps its
  own mode. The `Mode` bar item, in no default bar, shows any mode other
  than `default`.
- `domicile send-shell <command>` runs a command from a terminal:
  `domicile send-shell workspace 2`.
- Two queries answer from a terminal with JSON, for scripts:
  `domicile send-shell get-workspaces` lists each workspace with its screen,
  whether it shows, whether it has the keyboard, and its windows;
  `domicile send-shell get-tree` gives the screens, each workspace's tiling
  and floats, and every window. They run even while the launcher or overview
  is open.
- An unknown command logs to the console and does nothing.
- While the launcher is open, only the `launcher` command and mode changes
  run.
- `volume`, `mic` and `brightness` use the sound server and backlight the
  bar's items read ([HOST-READOUTS.md](../../shell-manganese/docs/HOST-READOUTS.md)).
  They do nothing without a sound server or a backlight.
- Each `volume`, `mic` and `brightness` press shows the new level in a toast
  at the bottom of the focused screen (`LevelNotice` in `shell-manganese`).
  Presses while it is up update it in place.
- `keymap` shows the keymap it switched to, and xkb's name for its layout,
  in the same kind of toast (`KeymapNotice`). The switch lasts until the desktop restarts, and works
  while locked ([SHELL-CONFIG.md](../../../docs/SHELL-CONFIG.md#keyboard)).

## Key names

- Keysyms resolve through the compositor's keymap (`input.keyboard`).
  `Meta+h` is whatever key types `h` in your layout.
- Shift is literal: `Meta+Shift+parenleft` is the `parenleft` key with Shift
  held.

## Example

The defaults, plus `btop` on Meta+Shift+B and workspaces on the
Programmer's Dvorak number row:

```tsx
import { runManganese } from "@domicile-desktop/manganese";
import {
  DEFAULT_KEYBINDINGS,
  exec,
  moveToWorkspace,
  workspace,
} from "@domicile-desktop/manganese-window-management/keyboard/commands";

/** Programmer's Dvorak's number row, unshifted, for workspaces 1 to 10. */
const ROW = [
  "parenleft", "parenright", "braceright", "plus", "braceleft",
  "bracketright", "bracketleft", "exclam", "equal", "asterisk",
];

export const Shell = runManganese({
  keybindings: {
    keybindings: {
      ...DEFAULT_KEYBINDINGS,
      "Meta+Shift+b": exec("kitty", "btop"),
      ...Object.fromEntries(
        ROW.flatMap((key, at) => [
          [`Meta+${key}`, workspace(String(at + 1))],
          [`Meta+Shift+${key}`, moveToWorkspace(String(at + 1))],
        ]),
      ),
    },
  },
});
```

These keysyms need the matching layout in the config. The compositor defaults
to plain `us`:

```ts
export const input = {
  keyboard: { xkb_layout: "us", xkb_variant: "dvp", xkb_options: ["caps:swapescape"] },
};
```

## Where bindings work

Bindings work whether the shell, a Wayland window or a browser window has
focus. Each press runs once. See
[KEYBINDINGS.md](../../../docs/architecture/KEYBINDINGS.md).

## Differences from sway

- **`exec` takes an argv**, not a `sh -c` string. For pipes, `&&` or `$VAR`,
  use `exec("sh", "-c", "…")`.
- **No per-window rules** (`for_window`). Every window opens tiled.
- **Every window is in a tab group.** A new window always opens as a tab, and
  `split h` / `split v` move a window out of its group instead of choosing
  where the next one opens.
- **No `reload` or `exit`.** There is no config to re-read or session to end
  from the page.
- **No output, input or bar config.** The compositor's config sets displays and
  the keyboard. The bar is part of the page.
- **No per-window borders** or `hideEdgeBorders`. Every window has the same
  CSS frame.
