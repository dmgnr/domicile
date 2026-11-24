import type { Result } from "@cprussin/option-result";
import { Ok } from "@cprussin/option-result";
import type { KeyBinding } from "@domicile-desktop/sdk/bind-keys";
import { bindKeys } from "@domicile-desktop/sdk/bind-keys";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { ShellKeybindings } from "@domicile-desktop/sdk/own-keybindings";
import type { CommandRan } from "@domicile-desktop/sdk/shell-command";
import { useEffect, useEffectEvent, useRef } from "react";
import type { WindowAction } from "../window-state";
import { WindowActionKind } from "../window-state";

import { COMMAND_HELP, parseCommand } from "./command";
import type { Query } from "./query";
import { parseQuery, QUERY_HELP } from "./query";

/** Every command and query, for `domicile list-shell-commands`. */
const HELP = [...COMMAND_HELP, ...QUERY_HELP];

/** Report an unknown command. */
const logToConsole = (error: string): void => {
  // biome-ignore lint/suspicious/noConsole: the bindings are the user's, and the console is where a shell tells them one named nothing
  console.error(error);
};

type Options = {
  domicile: Domicile;
  /** The shell's keybindings. */
  keybindings: ShellKeybindings;
  /** Whether the launcher is open, which blocks every key but its own. */
  launcherOpen: boolean;
  /** The desk-wide binding mode, whichever page entered it. */
  mode: string;
  /** Whether the overview is open, which blocks every key but its own. */
  overviewOpen: boolean;
  /** Receives the action a key asks for. */
  onAction: (action: WindowAction) => void;
  /** Called when a key on this page enters a binding mode. */
  onModeChanged: (mode: string) => void;
  /** Answers a query such as `get-tree` with JSON. */
  answer: (query: Query) => string;
  /** Reports unknown commands. Injectable for tests. */
  report?: typeof logToConsole;
};

/**
 * Bind the shell's keys and dispatch their commands.
 *
 * The SDK grabs the chords and reads each `shortcut` in the binding mode. This
 * hook parses `send-shell` commands (see `command.ts`), blocks keys while the
 * launcher or the overview is open, and syncs the binding mode.
 *
 * The mode is desk-wide: each monitor is a separate page, so a mode entered on
 * one page goes out via `onModeChanged` and comes back to every page as
 * `mode`.
 *
 * Binds once per host and keybindings, not per render.
 */
export const useKeybindings = ({
  answer,
  domicile,
  keybindings,
  launcherOpen,
  mode,
  onAction,
  onModeChanged,
  overviewOpen,
  report = logToConsole,
}: Options): void => {
  const binding = useRef<KeyBinding | undefined>(undefined);

  // A known command the launcher or overview holds back still counts as run:
  // it is the shell's to hold back. A query changes nothing, so it always
  // answers.
  const onCommand = useEffectEvent(
    (args: readonly string[]): Result<CommandRan, string> => {
      const query = parseQuery(args);
      if (query !== undefined) {
        return Ok({ output: answer(query) });
      }
      return parseCommand(args).map((action) => {
        if (
          (!launcherOpen || heardOverLauncher(action)) &&
          (!overviewOpen || HEARD_OVER_OVERVIEW.has(action.kind))
        ) {
          onAction(action);
        }
        return "ran" as const;
      });
    },
  );

  const reportRefusal = useEffectEvent((why: string) => {
    report(why);
  });

  const modeChanged = useEffectEvent((entered: string) => {
    onModeChanged(entered);
  });

  useEffect(() => {
    const bound = bindKeys(domicile, keybindings, {
      commands: HELP,
      onCommand,
      onModeChanged: modeChanged,
      reportRefusal: (why) => {
        reportRefusal(why);
      },
    });
    binding.current = bound;
    return bound.unbind;
  }, [domicile, keybindings]);

  // Must follow the binding effect, so the first mode reaches a live binding.
  useEffect(() => {
    binding.current?.setMode(mode);
  }, [mode]);
};

/**
 * Whether an action runs while the launcher is open.
 *
 * The launcher is modal, so keys must not act on windows behind it. Its own
 * toggle runs, and so does a screenshot, which acts on no window and is how
 * the launcher is shot.
 */
const heardOverLauncher = (action: WindowAction): boolean =>
  action.kind === WindowActionKind.LauncherToggled ||
  action.kind === WindowActionKind.ScreenshotTaken;

/**
 * The actions a key runs while the overview is open: its own, which steer it
 * (see `steeredInOverview`), close it or swap it for the launcher or the
 * clipboard, and the keys a keyboard's hardware labels, which act on no
 * window. The overview is for picking a workspace, so keys that open or work
 * windows behind it wait.
 */
const HEARD_OVER_OVERVIEW: ReadonlySet<WindowActionKind> = new Set([
  WindowActionKind.ClipboardToggled,
  WindowActionKind.DeskLocked,
  WindowActionKind.FocusStepped,
  WindowActionKind.LauncherToggled,
  WindowActionKind.LayerLowered,
  WindowActionKind.LayerRaised,
  WindowActionKind.MediaKeyPressed,
  WindowActionKind.OverviewDismissed,
  WindowActionKind.OverviewShown,
  WindowActionKind.OverviewToggled,
  WindowActionKind.ScreenshotTaken,
  WindowActionKind.WindowStepped,
]);
