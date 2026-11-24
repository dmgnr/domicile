import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";
import { InhibitorAction } from "@domicile-desktop/sdk/inhibitor-action";
import { KeymapChoice } from "@domicile-desktop/sdk/keymap-choice";

import { Axis, Direction } from "../direction";
import { Layout } from "../tree/node";
import type { WindowAction as Action } from "../window-state";
import { WindowAction } from "../window-state";
import { COMMAND_HELP, parseCommand } from "./command";
import { MediaKey } from "./media-key";

/** Parse a command as written after `send-shell`. */
const parsing = (command: string) => parseCommand(command.split(" "));

describe("parseCommand", () => {
  it.each<readonly [string, Action]>([
    ["kill", WindowAction.WindowKilled()],
    ["lock", WindowAction.DeskLocked()],
    ["launcher", WindowAction.LauncherToggled()],
    ["overview", WindowAction.OverviewToggled()],
    ["clipboard", WindowAction.ClipboardToggled()],
    ["screenshot", WindowAction.ScreenshotTaken()],
    ["terminal", WindowAction.TerminalOpened()],
    ["search-clipboard", WindowAction.ClipboardSearched()],
    ["notifications", WindowAction.NotificationsToggled()],
    ["notifications clear", WindowAction.NotificationsCleared()],
    ["idle-inhibitor", WindowAction.IdleInhibitorToggled()],
    ["night-light", WindowAction.NightLightToggled()],
    [
      "shortcuts-inhibitor toggle",
      WindowAction.ShortcutsInhibitorSwitched(InhibitorAction.Toggle),
    ],
    [
      "shortcuts-inhibitor deactivate",
      WindowAction.ShortcutsInhibitorSwitched(InhibitorAction.Deactivate),
    ],
    ["volume up", WindowAction.MediaKeyPressed(MediaKey.VolumeUp)],
    ["volume down", WindowAction.MediaKeyPressed(MediaKey.VolumeDown)],
    ["volume mute", WindowAction.MediaKeyPressed(MediaKey.VolumeMute)],
    ["mic mute", WindowAction.MediaKeyPressed(MediaKey.MicMute)],
    ["brightness up", WindowAction.MediaKeyPressed(MediaKey.BrightnessUp)],
    ["brightness down", WindowAction.MediaKeyPressed(MediaKey.BrightnessDown)],
    ["focus left", WindowAction.FocusStepped(Direction.Left)],
    ["focus right", WindowAction.FocusStepped(Direction.Right)],
    ["focus up", WindowAction.FocusStepped(Direction.Up)],
    ["focus down", WindowAction.FocusStepped(Direction.Down)],
    ["focus parent", WindowAction.ParentFocused()],
    ["focus child", WindowAction.ChildFocused()],
    ["focus mode_toggle", WindowAction.ModeSwapped()],
    ["move left", WindowAction.WindowStepped(Direction.Left)],
    ["move down", WindowAction.WindowStepped(Direction.Down)],
    ["move scratchpad", WindowAction.WindowSentToScratchpad()],
    [
      "move container to workspace 10",
      WindowAction.WindowSentToWorkspace("10"),
    ],
    ["split h", WindowAction.ContainerSplit(Axis.Horizontal)],
    ["split v", WindowAction.ContainerSplit(Axis.Vertical)],
    ["splith", WindowAction.ContainerSplit(Axis.Horizontal)],
    ["splitv", WindowAction.ContainerSplit(Axis.Vertical)],
    ["layout stacking", WindowAction.LayoutSet(Layout.Stacking)],
    ["layout tabbed", WindowAction.LayoutSet(Layout.Tabbed)],
    ["layout toggle split", WindowAction.SplitToggled()],
    ["group", WindowAction.TabSubgrouped()],
    ["fullscreen toggle", WindowAction.FullscreenToggled(false)],
    ["fullscreen toggle global", WindowAction.FullscreenToggled(true)],
    ["floating toggle", WindowAction.FloatToggled()],
    ["scratchpad show", WindowAction.ScratchpadShown()],
    ["scratchpad bring", WindowAction.ScratchpadBrought()],
    ["scratchpad hide", WindowAction.ScratchpadHidden()],
    ["overview show", WindowAction.OverviewShown()],
    ["overview hide", WindowAction.OverviewDismissed()],
    ["layer up", WindowAction.LayerRaised()],
    ["layer down", WindowAction.LayerLowered()],
    ["workspace 1", WindowAction.WorkspaceSelected("1")],
    ["workspace next_on_output", WindowAction.WorkspaceStepped("next")],
    ["workspace prev_on_output", WindowAction.WorkspaceStepped("prev")],
    ["resize grow up", WindowAction.WindowGrown(Direction.Up)],
    ["resize grow right", WindowAction.WindowGrown(Direction.Right)],
    ["keymap next", WindowAction.KeymapSelected(KeymapChoice.Next())],
    ["keymap us", WindowAction.KeymapSelected(KeymapChoice.Named("us"))],
    [
      "keymap us intl",
      WindowAction.KeymapSelected(KeymapChoice.Named("us intl")),
    ],
    [
      "virtual-monitor add",
      WindowAction.VirtualMonitorAdded({ height: 1080, width: 1920 }),
    ],
    [
      "virtual-monitor add 2560x1440",
      WindowAction.VirtualMonitorAdded({ height: 1440, width: 2560 }),
    ],
    ["virtual-monitor remove", WindowAction.VirtualMonitorRemoved()],
  ])("reads `%s` as sway does", (command, action) => {
    expect(parsing(command)).toStrictEqual(Ok(action));
  });

  it("refuses `keymap` with no keymap", () => {
    expect(parseCommand(["keymap"])).toStrictEqual(
      Err("manganese: `keymap` names no keymap"),
    );
  });

  it.each([
    "virtual-monitor",
    "virtual-monitor add big",
    "virtual-monitor add 0x1080",
    "virtual-monitor add 1920x1080 now",
    "virtual-monitor remove now",
  ])("refuses `%s`, saying how to write it", (command) => {
    expect(parsing(command)).toStrictEqual(
      Err(
        `manganese: no command \`${command}\`; write \`virtual-monitor add [<width>x<height>]\` or \`virtual-monitor remove\``,
      ),
    );
  });

  it("leaves `exec` to Domicile, which starts programs for every shell", () => {
    expect(parseCommand(["exec", "kitty"]).isErr()).toBe(true);
  });

  it.each([
    // Unknown verb.
    "teleport",
    // Unknown argument.
    "focus sideways",
    // Workspace out of range.
    "workspace 11",
    // Extra word.
    "kill now",
  ])("refuses `%s`, naming it", (command) => {
    expect(parsing(command)).toStrictEqual(
      Err(`manganese: no command \`${command}\``),
    );
  });
});

/**
 * Every command `usage` describes, with a sample for each `<placeholder>`, each
 * `a|b` alternative and each `[optional]` part.
 */
const commandsOf = (usage: string): string[] =>
  usage
    .split(" ")
    .reduce<string[][]>(
      (commands, word) => {
        const optional = /^\[(.*)\]$/.exec(word);
        const words =
          optional === null
            ? alternativesOf(word)
            : ["", ...alternativesOf(optional[1] ?? "")];
        return commands.flatMap((command) =>
          words.map((each) => (each === "" ? command : [...command, each])),
        );
      },
      [[]],
    )
    .map((words) => words.join(" "));

/** A word's alternatives, with a sample for a placeholder. */
const alternativesOf = (word: string): string[] =>
  word.split("|").map((each) => {
    switch (each) {
      case "<name>":
        return "1";
      case "<argv…>":
        return "foot";
      case "<width>x<height>":
        return "1280x720";
      default:
        return each;
    }
  });

describe("COMMAND_HELP", () => {
  it.each(COMMAND_HELP.map(({ usage }) => usage))(
    "describes `%s`, which parses",
    (usage) => {
      for (const command of commandsOf(usage)) {
        expect([command, parsing(command).isOk()]).toStrictEqual([
          command,
          true,
        ]);
      }
    },
  );

  it("describes every command manganese runs", () => {
    // A sample of each verb `parseCommand` takes, so a new command needs a
    // line of help before this passes.
    const described = COMMAND_HELP.flatMap(({ usage }) => commandsOf(usage));
    const undescribed = [
      "kill",
      "lock",
      "launcher",
      "overview",
      "overview show",
      "clipboard",
      "screenshot",
      "terminal",
      "search-clipboard",
      "notifications",
      "notifications clear",
      "idle-inhibitor",
      "night-light",
      "shortcuts-inhibitor toggle",
      "volume mute",
      "mic mute",
      "brightness up",
      "focus parent",
      "focus mode_toggle",
      "move scratchpad",
      "move container to workspace 1",
      "split h",
      "splitv",
      "layout tabbed",
      "layout toggle split",
      "group",
      "fullscreen toggle global",
      "floating toggle",
      "scratchpad show",
      "scratchpad hide",
      "workspace 1",
      "workspace next_on_output",
      "resize grow up",
      "keymap next",
      "virtual-monitor add 1280x720",
      "virtual-monitor remove",
    ].filter((command) => !described.includes(command));

    expect(undescribed).toStrictEqual([]);
  });
});
