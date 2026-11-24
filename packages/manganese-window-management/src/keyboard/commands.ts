// Typed builders for manganese's commands, and the default keybindings.
//
// Each builder produces the `send-shell` words `command.ts` parses, so a
// binding in a shell's options is type-checked where it is written.

import { KeyAction } from "@domicile-desktop/sdk/key-action";
import type { ModeKeybindings } from "@domicile-desktop/sdk/own-keybindings";

/** A direction. */
export type Way = "left" | "down" | "up" | "right";

/** A manganese command, as the words after `send-shell`. */
const command = (...words: readonly string[]) => KeyAction.SendShell(words);

/**
 * Start `argv` directly, without a shell, as `domicile exec` does. Domicile
 * runs it, not manganese.
 */
export const exec = (...argv: readonly string[]) => KeyAction.Exec(argv);
/**
 * Open the terminal the desk's config names (`terminal`). Does nothing on a
 * desk that names none.
 */
export const terminal = () => command("terminal");
/** Close the focused window, or every window in a `focus parent` selection. */
export const kill = () => command("kill");
/** Lock the desk. */
export const lock = () => command("lock");
/** Toggle the launcher. */
export const launcher = () => command("launcher");
/**
 * Toggle the overview: each screen's workspaces at once. `only` opens it
 * without closing it, or closes it without opening it.
 */
export const overview = (only?: "hide" | "show") =>
  only === undefined ? command("overview") : command("overview", only);
/** Step between the scratchpad, the desk and the overview. */
export const layer = (way: "down" | "up") => command("layer", way);
/** Toggle the clipboard history. */
export const clipboard = () => command("clipboard");
/** Open the newest copy as a site if it is a URL, else search for it. */
export const searchClipboard = () => command("search-clipboard");
/** Toggle the notification drawer. */
export const notifications = () => command("notifications");
/** Clear every notification. */
export const clearNotifications = () => command("notifications", "clear");
/** Toggle keeping the screens on. */
export const idleInhibitor = () => command("idle-inhibitor");
/**
 * Add a monitor with no connector, 1920x1080 unless `size` says otherwise.
 */
export const virtualMonitor = (size?: {
  readonly width: number;
  readonly height: number;
}) =>
  size === undefined
    ? command("virtual-monitor", "add")
    : command(
        "virtual-monitor",
        "add",
        `${String(size.width)}x${String(size.height)}`,
      );
/** Remove the newest virtual monitor added. */
export const removeVirtualMonitor = () => command("virtual-monitor", "remove");
/** Toggle the night light. */
export const nightLight = () => command("night-light");
/** Take a screenshot, picking the area in a dialog. */
export const screenshot = () => command("screenshot");
/** Switch to the next of the config's keymaps, or to the one named. */
export const keymap = (name: string) => command("keymap", name);
/** Step the default output's volume, or toggle its mute. */
export const volume = (change: "up" | "down" | "mute") =>
  command("volume", change);
/** Toggle the default input's mute. */
export const micMute = () => command("mic", "mute");
/** Step the screen's brightness. */
export const brightness = (change: "up" | "down") =>
  command("brightness", change);
/** Move the focus, or focus the parent or child container. */
export const focus = (to: Way | "parent" | "child" | "mode_toggle") =>
  command("focus", to);
/** Move the window, or send it to the scratchpad. */
export const move = (to: Way | "scratchpad") => command("move", to);
/** Send the window to workspace `1` to `10` without following it. */
export const moveToWorkspace = (name: string) =>
  command("move", "container", "to", "workspace", name);
/** Go to a workspace, `1` to `10`. */
export const workspace = (name: string) => command("workspace", name);
/** Go to the screen's next or previous workspace, wrapping around. */
export const stepWorkspace = (way: "next" | "prev") =>
  command("workspace", `${way}_on_output`);
/** Wrap the focused window in a new container. */
export const split = (axis: "h" | "v") => command("split", axis);
/** Set the layout of the focused container. */
export const layout = (as: "stacking" | "tabbed" | "toggle split") =>
  command("layout", ...as.split(" "));
/** Turn the focused tab into a group of its own, nested in its slot. */
export const group = () => command("group");
/** Toggle fullscreen, across every screen with `global`. */
export const fullscreen = (global = false) =>
  global
    ? command("fullscreen", "toggle", "global")
    : command("fullscreen", "toggle");
/** Toggle floating. */
export const floating = () => command("floating", "toggle");
/**
 * Show the next scratchpad window, or hide the shown one. `bring` only shows
 * one, when none is out; `hide` only hides it.
 */
export const scratchpad = (only?: "bring" | "hide") =>
  command("scratchpad", only ?? "show");
/** Grow the window in a direction, shrinking its neighbor. */
export const grow = (way: Way) => command("resize", "grow", way);
/** Enter a binding mode. */
export const mode = (name: string) => KeyAction.Mode(name);

/** Vim keys and arrow keys, by direction. */
const WAYS: readonly (readonly [Way, readonly string[]])[] = [
  ["left", ["h", "Left"]],
  ["down", ["j", "Down"]],
  ["up", ["k", "Up"]],
  ["right", ["l", "Right"]],
];

/** Bind `Meta+<held><key>` to `each` for every direction key. */
const everyWay = (
  held: string,
  each: (way: Way) => KeyAction,
): ModeKeybindings =>
  Object.fromEntries(
    WAYS.flatMap(([way, keys]) =>
      keys.map((key) => [`Meta+${held}${key}`, each(way)] as const),
    ),
  );

/** Bind `Meta+<held><digit>` to `each` for workspaces 1 to 10 (keys 1 to 0). */
const everyWorkspace = (
  held: string,
  each: (name: string) => KeyAction,
): ModeKeybindings =>
  Object.fromEntries(
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((digit, at) => [
      `Meta+${held}${digit}`,
      each(String(at + 1)),
    ]),
  );

/**
 * Default bindings for mode `default`: sway's, on Meta, and a tap of Meta alone
 * toggling the overview; touchpad swipes,
 * three fingers moving focus and four going sideways between workspaces and
 * down and up for the scratchpad; four fingers pinching in to open the
 * overview and spreading to close it; three spreading for the launcher; and touchscreen swipes in from the sides
 * between workspaces. Spread into your own table to override individual keys.
 */
export const DEFAULT_KEYBINDINGS: ModeKeybindings = {
  // The workspace follows the finger in from the screen's side, as the
  // four-finger swipes below go.
  "edge:left": stepWorkspace("prev"),
  "edge:right": stepWorkspace("next"),
  // Super tapped alone, as on GNOME and KDE. Held for a chord, dragging or
  // scrolling, it is no tap.
  Meta: overview(),
  "Meta+a": focus("parent"),
  "Meta+b": split("h"),
  "Meta+d": launcher(),
  "Meta+e": layout("toggle split"),
  "Meta+f": fullscreen(),
  "Meta+g": group(),
  "Meta+minus": scratchpad(),
  "Meta+o": overview(),
  "Meta+Return": terminal(),
  "Meta+Shift+a": focus("child"),
  "Meta+Shift+f": fullscreen(true),
  "Meta+Shift+minus": move("scratchpad"),
  "Meta+Shift+q": kill(),
  "Meta+Shift+Return": lock(),
  "Meta+Shift+space": searchClipboard(),
  "Meta+Shift+Tab": floating(),
  "Meta+Shift+v": clipboard(),
  "Meta+s": layout("stacking"),
  "Meta+space": launcher(),
  "Meta+Tab": focus("mode_toggle"),
  "Meta+v": split("v"),
  "Meta+w": layout("tabbed"),
  Print: screenshot(),
  // Three fingers spreading open the launcher, closing the overview.
  "pinch:3:outward": launcher(),
  // Pinching in zooms out to the workspaces, and spreading zooms back in.
  "pinch:4:inward": overview("show"),
  "pinch:4:outward": overview("hide"),
  // Focus goes where the fingers point, as Meta+H/J/K/L do: nothing slides.
  "swipe:3:down": focus("down"),
  "swipe:3:left": focus("left"),
  "swipe:3:right": focus("right"),
  "swipe:3:up": focus("up"),
  // The scratchpad hangs above the desk and the overview sits under it: down
  // pulls the scratchpad down or closes the overview, up the reverse.
  "swipe:4:down": layer("down"),
  // The workspace follows the fingers, as a page does.
  "swipe:4:left": stepWorkspace("next"),
  "swipe:4:right": stepWorkspace("prev"),
  "swipe:4:up": layer("up"),
  XF86AudioLowerVolume: volume("down"),
  XF86AudioMicMute: micMute(),
  XF86AudioMute: volume("mute"),
  XF86AudioRaiseVolume: volume("up"),
  XF86MonBrightnessDown: brightness("down"),
  XF86MonBrightnessUp: brightness("up"),
  ...everyWay("", focus),
  ...everyWay("Shift+", move),
  ...everyWorkspace("", workspace),
  ...everyWorkspace("Shift+", moveToWorkspace),
};
