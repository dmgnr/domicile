// Parses the words of a `send-shell <words>` binding into a window action.
//
// - Commands use sway's syntax where sway has one (`focus left`, `layout
//   tabbed`), so sway bindings can be copied over. `lock`, `launcher`,
//   `overview`, `layer`, `clipboard`, `search-clipboard`, `screenshot`, `terminal`,
//   `volume`, `mic`,
//   `brightness`, `keymap`, `notifications`, `idle-inhibitor`,
//   `night-light`, `virtual-monitor` and `resize grow <direction>` are
//   manganese's own.
// - `exec <argv…>` runs the argv directly, not through `sh -c` as sway does.
// - An unknown command is a config error, so it returns an `Err`, not a throw.
//
// See docs/architecture/KEYBINDINGS.md.

import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { InhibitorAction } from "@domicile-desktop/sdk/inhibitor-action";
import { KeymapChoice } from "@domicile-desktop/sdk/keymap-choice";
import type { ShellCommandHelp } from "@domicile-desktop/sdk/shell-command";

import { Axis, Direction } from "../direction";
import { Layout } from "../tree/node";
import type { WindowAction as Action } from "../window-state";
import { WindowAction, WORKSPACES } from "../window-state";
import { MediaKey } from "./media-key";

/** Sway's direction words. */
const DIRECTIONS: readonly (readonly [word: string, way: Direction])[] = [
  ["left", Direction.Left],
  ["down", Direction.Down],
  ["up", Direction.Up],
  ["right", Direction.Right],
];

/** A command's words and its action. */
type Command = readonly [words: string, action: Action];

/** Every known command, by its words. */
const COMMANDS: ReadonlyMap<string, Action> = new Map<string, Action>([
  ["kill", WindowAction.WindowKilled()],
  // Sway has no lock command.
  ["lock", WindowAction.DeskLocked()],
  // A toggle, so the same key opens and closes it. Escape and the backdrop
  // close it from the dialog (see `launcher/Launcher.tsx`).
  ["launcher", WindowAction.LauncherToggled()],
  // Each screen's workspaces at once; a toggle, like the launcher.
  ["overview", WindowAction.OverviewToggled()],
  // Manganese's: one way each, for gestures that go one way.
  ["overview show", WindowAction.OverviewShown()],
  ["overview hide", WindowAction.OverviewDismissed()],
  // Manganese's: up hides the scratchpad or else shows the overview; down
  // closes the overview or else brings the scratchpad.
  ["layer up", WindowAction.LayerRaised()],
  ["layer down", WindowAction.LayerLowered()],
  // Clipboard history; a toggle, like the launcher.
  ["clipboard", WindowAction.ClipboardToggled()],
  // The area is picked in the screenshot dialog.
  ["screenshot", WindowAction.ScreenshotTaken()],
  // The config's `terminal`; nothing on a desk that names none.
  ["terminal", WindowAction.TerminalOpened()],
  // The newest copy, as a site or a search.
  ["search-clipboard", WindowAction.ClipboardSearched()],
  // The drawer; a toggle, like the launcher.
  ["notifications", WindowAction.NotificationsToggled()],
  ["notifications clear", WindowAction.NotificationsCleared()],
  // The bar's eye; a toggle.
  ["idle-inhibitor", WindowAction.IdleInhibitorToggled()],
  // The brightness popover's switch; a toggle.
  ["night-light", WindowAction.NightLightToggled()],
  [
    "shortcuts-inhibitor activate",
    WindowAction.ShortcutsInhibitorSwitched(InhibitorAction.Activate),
  ],
  [
    "shortcuts-inhibitor deactivate",
    WindowAction.ShortcutsInhibitorSwitched(InhibitorAction.Deactivate),
  ],
  [
    "shortcuts-inhibitor toggle",
    WindowAction.ShortcutsInhibitorSwitched(InhibitorAction.Toggle),
  ],
  ["volume up", WindowAction.MediaKeyPressed(MediaKey.VolumeUp)],
  ["volume down", WindowAction.MediaKeyPressed(MediaKey.VolumeDown)],
  ["volume mute", WindowAction.MediaKeyPressed(MediaKey.VolumeMute)],
  ["mic mute", WindowAction.MediaKeyPressed(MediaKey.MicMute)],
  ["brightness up", WindowAction.MediaKeyPressed(MediaKey.BrightnessUp)],
  ["brightness down", WindowAction.MediaKeyPressed(MediaKey.BrightnessDown)],
  ...DIRECTIONS.map(
    ([word, way]): Command => [`focus ${word}`, WindowAction.FocusStepped(way)],
  ),
  ["focus parent", WindowAction.ParentFocused()],
  ["focus child", WindowAction.ChildFocused()],
  ["focus mode_toggle", WindowAction.ModeSwapped()],
  ...DIRECTIONS.map(
    ([word, way]): Command => [`move ${word}`, WindowAction.WindowStepped(way)],
  ),
  ["move scratchpad", WindowAction.WindowSentToScratchpad()],
  ["split h", WindowAction.ContainerSplit(Axis.Horizontal)],
  ["split v", WindowAction.ContainerSplit(Axis.Vertical)],
  ["splith", WindowAction.ContainerSplit(Axis.Horizontal)],
  ["splitv", WindowAction.ContainerSplit(Axis.Vertical)],
  ["layout stacking", WindowAction.LayoutSet(Layout.Stacking)],
  ["layout tabbed", WindowAction.LayoutSet(Layout.Tabbed)],
  ["layout toggle split", WindowAction.SplitToggled()],
  // Manganese's: the focused tab becomes a group nested in its slot.
  ["group", WindowAction.TabSubgrouped()],
  ["fullscreen toggle", WindowAction.FullscreenToggled(false)],
  ["fullscreen toggle global", WindowAction.FullscreenToggled(true)],
  ["floating toggle", WindowAction.FloatToggled()],
  ["scratchpad show", WindowAction.ScratchpadShown()],
  // Manganese's: one way each, for gestures that go one way.
  ["scratchpad bring", WindowAction.ScratchpadBrought()],
  ["scratchpad hide", WindowAction.ScratchpadHidden()],
  ...DIRECTIONS.map(
    ([word, way]): Command => [
      `resize grow ${word}`,
      WindowAction.WindowGrown(way),
    ],
  ),
  ["workspace next_on_output", WindowAction.WorkspaceStepped("next")],
  ["workspace prev_on_output", WindowAction.WorkspaceStepped("prev")],
  ...WORKSPACES.flatMap((name): Command[] => [
    [`workspace ${name}`, WindowAction.WorkspaceSelected(name)],
    [
      `move container to workspace ${name}`,
      WindowAction.WindowSentToWorkspace(name),
    ],
  ]),
]);

/**
 * Every command, for `domicile list-shell-commands`. Matches the tables in
 * this package's docs/KEYS.md; `command.test.ts` checks each parses and none is missing.
 */
export const COMMAND_HELP: readonly ShellCommandHelp[] = [
  {
    description: "Close the window, or the `focus parent` selection.",
    usage: "kill",
  },
  { description: "Move focus.", usage: "focus left|right|up|down" },
  {
    description: "Select the enclosing container, or go back to the window.",
    usage: "focus parent|child",
  },
  {
    description: "Switch between floating and tiled windows.",
    usage: "focus mode_toggle",
  },
  {
    description:
      "Move the window, or the selection, along its tabs, then out of its group.",
    usage: "move left|right|up|down",
  },
  {
    description: "Hide the window in the scratchpad.",
    usage: "move scratchpad",
  },
  {
    description:
      "Show the oldest hidden window, or hide the shown one; or one way only.",
    usage: "scratchpad show|bring|hide",
  },
  {
    description: "Send the window, or the selection, to workspace 1–10.",
    usage: "move container to workspace <name>",
  },
  {
    description: "Go to workspace 1–10, or back if it is shown.",
    usage: "workspace <name>",
  },
  {
    description: "Go to the next or previous workspace on this screen.",
    usage: "workspace next_on_output|prev_on_output",
  },
  {
    description:
      "Move the window, or the selection, out of its tab group, right or below.",
    usage: "split h|v",
  },
  {
    description: "The same as `split h` and `split v`.",
    usage: "splith|splitv",
  },
  {
    description: "Set the container's layout.",
    usage: "layout stacking|tabbed",
  },
  {
    description: "Switch the container between splits and tabs.",
    usage: "layout toggle split",
  },
  {
    description: "Fullscreen on this screen, or every screen.",
    usage: "fullscreen toggle [global]",
  },
  { description: "Float or tile the window.", usage: "floating toggle" },
  {
    description: "Grow the window that way.",
    usage: "resize grow left|right|up|down",
  },
  { description: "Open the config's terminal.", usage: "terminal" },
  { description: "Lock the desktop.", usage: "lock" },
  {
    description:
      "Turn the focused tab into a group of its own, nested in its slot.",
    usage: "group",
  },
  { description: "Toggle the launcher.", usage: "launcher" },
  {
    description:
      "Toggle the overview of every screen's workspaces, or one way only.",
    usage: "overview [show|hide]",
  },
  {
    description:
      "Step from the scratchpad to the desk to the overview, or back down.",
    usage: "layer up|down",
  },
  { description: "Toggle the clipboard history.", usage: "clipboard" },
  { description: "Take a screenshot, as Print does.", usage: "screenshot" },
  {
    description:
      "Open the newest copy in a browser window, as a site or a search.",
    usage: "search-clipboard",
  },
  {
    description: "Step the default output's volume, or toggle its mute.",
    usage: "volume up|down|mute",
  },
  { description: "Toggle the default microphone's mute.", usage: "mic mute" },
  { description: "Step the brightness.", usage: "brightness up|down" },
  {
    description: "Toggle the notification drawer, or clear every notification.",
    usage: "notifications [clear]",
  },
  { description: "Toggle keeping the screens on.", usage: "idle-inhibitor" },
  { description: "Toggle the night light.", usage: "night-light" },
  {
    description: "Add a monitor with no connector, 1920x1080 by default.",
    usage: "virtual-monitor add [<width>x<height>]",
  },
  {
    description: "Remove the newest virtual monitor.",
    usage: "virtual-monitor remove",
  },
  {
    description: "Switch every keyboard to the next keymap, or the one named.",
    usage: "keymap next|<name>",
  },
  {
    description:
      "Turn off, or back on, the focused window's hold on your shortcuts.",
    usage: "shortcuts-inhibitor toggle|activate|deactivate",
  },
];

/** Parse the words after `send-shell`, or `Err` for an unknown command. */
export const parseCommand = (
  args: readonly string[],
): Result<Action, string> => {
  const [verb, ...argv] = args;
  switch (verb) {
    case "keymap":
      return parseKeymap(argv);
    case "virtual-monitor":
      return parseVirtualMonitor(args);
    default:
      return parseNamed(args);
  }
};

/** Parse `keymap next` or `keymap <name>`; a name may hold spaces. */
const parseKeymap = (words: readonly string[]): Result<Action, string> => {
  const name = words.join(" ");
  if (name === "") {
    return Err("manganese: `keymap` names no keymap");
  } else {
    return Ok(
      WindowAction.KeymapSelected(
        name === "next" ? KeymapChoice.Next() : KeymapChoice.Named(name),
      ),
    );
  }
};

/** A virtual monitor's size when `virtual-monitor add` names none. */
const DEFAULT_VIRTUAL_MONITOR = { height: 1080, width: 1920 };

/** Parse `virtual-monitor add [<width>x<height>]` or `virtual-monitor remove`. */
const parseVirtualMonitor = (
  args: readonly string[],
): Result<Action, string> => {
  const [, verb, size, ...rest] = args;
  const dimensions = /^([1-9]\d*)x([1-9]\d*)$/.exec(size ?? "");
  if (rest.length > 0) {
    return virtualMonitorUsage(args);
  } else if (verb === "remove" && size === undefined) {
    return Ok(WindowAction.VirtualMonitorRemoved());
  } else if (verb === "add" && size === undefined) {
    return Ok(WindowAction.VirtualMonitorAdded(DEFAULT_VIRTUAL_MONITOR));
  } else if (verb === "add" && dimensions !== null) {
    return Ok(
      WindowAction.VirtualMonitorAdded({
        height: Number(dimensions[2]),
        width: Number(dimensions[1]),
      }),
    );
  } else {
    return virtualMonitorUsage(args);
  }
};

const virtualMonitorUsage = (args: readonly string[]): Result<Action, string> =>
  Err(
    `manganese: no command \`${args.join(" ")}\`; write \`virtual-monitor add [<width>x<height>]\` or \`virtual-monitor remove\``,
  );

/** Look up a command in {@link COMMANDS}. */
const parseNamed = (args: readonly string[]): Result<Action, string> => {
  const command = args.join(" ");
  const action = COMMANDS.get(command);
  return action === undefined
    ? Err(`manganese: no command \`${command}\``)
    : Ok(action);
};
