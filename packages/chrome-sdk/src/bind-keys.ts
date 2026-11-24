// Grabs and handles a shell's keybindings.
//
// `grabShortcut` takes each chord by name; the engine finds its key and sends
// every press, from a `<webview>` or the page, as a `shortcut` event carrying
// the chord.
//
// Touchpad gestures (`swipe:3:left`) and touchscreen edge swipes
// (`edge:left`) bind beside chords and share their modes. `grabGesture`
// takes each kind and count, or edge; the engine sends every
// phase as a `gesture` event, and a binding runs once its gesture ends going
// its way. See docs/architecture/GESTURES.md.
//
// Binding modes are tracked here; the engine does not know about them. A
// command typed as `domicile send-shell` arrives as a shell command system
// event and runs as its `SendShell` binding would. See
// docs/architecture/KEYBINDINGS.md.

import type { Result } from "@cprussin/option-result";

import type { Gestures } from "./desktop/gestures";
import type { Keyboard } from "./desktop/keyboard";
import type { Processes } from "./desktop/processes";
import type { ShellNamespace } from "./desktop/shell";
import type { FinishedGesture } from "./gesture-binding";
import {
  bestGesture,
  gestureTracker,
  grabOf,
  isGesture,
  parseGesture,
} from "./gesture-binding";
import type { KeyAction, OneKeyAction } from "./key-action";
import { KeyActionKind } from "./key-action";
import type { KeybindingsByMode, ShellKeybindings } from "./own-keybindings";
import { inhibitedChords, ownKeybindings } from "./own-keybindings";
import type {
  CommandRan,
  ShellBinding,
  ShellCommand,
  ShellCommandHelp,
} from "./shell-command";
import type { Listening, SystemError } from "./system";

/** The initial binding mode. */
const DEFAULT_MODE = "default";

/** Callbacks {@link bindKeys} calls, and the commands the shell runs. */
export type KeyHandlers = {
  /**
   * The commands `onCommand` runs, which `domicile list-shell-commands`
   * prints.
   */
  commands: readonly ShellCommandHelp[];
  /**
   * A `send-shell` binding was pressed, or `domicile send-shell` sent a
   * command, with its arguments. `Ok({ output })` is printed by
   * `domicile send-shell`, as a query's answer; `Err` says why the shell did
   * not run it, which `domicile send-shell` fails with.
   */
  onCommand: (args: readonly string[]) => Result<CommandRan, string>;
  /** The binding mode changed. */
  onModeChanged: (mode: string) => void;
  /** The page cannot hear `domicile send-shell`. Logs by default. */
  report?: (error: SystemError) => void;
  /** A pressed binding's command was not run, and why. Logs by default. */
  reportRefusal?: (why: string) => void;
};

/** The handle {@link bindKeys} returns. */
export type KeyBinding = {
  /** Switch to binding mode `name`; see {@link bindKeys}. */
  setMode: (name: string) => void;
  /** Stop handling keys, and give back every chord and gesture grabbed. */
  unbind: () => void;
};

/** The part of the desktop that `bindKeys` uses. */
export type KeyDesktop = {
  readonly gestures: Pick<Gestures, "grab" | "on" | "ungrab">;
  readonly keyboard: Pick<Keyboard, "grab" | "on" | "ungrab">;
  readonly processes: Pick<Processes, "launch">;
  readonly shell: Pick<ShellNamespace, "commands" | "answer">;
};

/**
 * Handle the keybindings `own` for a shell.
 *
 * - Every chord in every mode is grabbed once, until `unbind`. A key bound in
 *   any mode is grabbed from all clients while bound.
 * - So is every gesture's kind and count: `swipe:3:left` grabs every
 *   three-finger swipe, whichever way it goes. An edge swipe's side is
 *   grabbed: `edge:left` withholds only fingers landing at the left edge.
 * - `setMode` syncs the mode across pages without calling `onModeChanged`. An
 *   unknown mode falls back to `default` and is reported.
 *
 * @throws for an invalid chord or gesture (see `ownKeybindings`), before anything is
 *   grabbed. A keysym the layout cannot type is logged, so the other keys
 *   still work.
 */
export const bindKeys = (
  domicile: KeyDesktop,
  own: ShellKeybindings,
  {
    commands: help,
    onCommand,
    onModeChanged,
    report = reportToConsole,
    reportRefusal = refusalToConsole,
  }: KeyHandlers,
): KeyBinding => {
  const bindings: KeybindingsByMode = ownKeybindings(own);
  const inhibited = inhibitedChords(own);
  let mode = DEFAULT_MODE;

  const enter = (next: string) => {
    if (next !== mode) {
      mode = next;
      onModeChanged(next);
    }
  };

  const run = (action: OneKeyAction | undefined) => {
    switch (action?.kind) {
      case KeyActionKind.SendShell: {
        onCommand(action.args).match({
          Err: reportRefusal,
          Ok: () => undefined,
        });
        break;
      }
      case KeyActionKind.Exec: {
        domicile.processes.launch(action.argv);
        break;
      }
      case KeyActionKind.Mode: {
        enter(action.name);
        break;
      }
      case undefined: {
        break;
      }
    }
  };

  // The release each held chord's press armed, by chord.
  const armed = new Map<string, OneKeyAction>();
  const press = (chord: string, action: KeyAction | undefined) => {
    switch (action?.kind) {
      case KeyActionKind.Hold: {
        if (!armed.has(chord)) {
          armed.set(chord, action.release);
          run(action.press);
        }
        break;
      }
      case KeyActionKind.SendShell:
      case KeyActionKind.Exec:
      case KeyActionKind.Mode:
      case undefined: {
        run(action);
        break;
      }
    }
  };
  const release = (chord: string) => {
    const action = armed.get(chord);
    armed.delete(chord);
    run(action);
  };

  const gesturesByMode = new Map(
    [...bindings].map(([name, byName]) => [
      name,
      [...byName]
        .filter(([written]) => isGesture(written))
        .map(
          ([written, action]) =>
            [parseGesture(written), gestureAction(written, action)] as const,
        ),
    ]),
  );
  const onGesture = (finished: FinishedGesture | undefined) => {
    if (finished !== undefined) {
      run(bestGesture(gesturesByMode.get(mode) ?? [], finished));
    }
  };

  const names = new Set(
    [...bindings.values()].flatMap((byName) => [...byName.keys()]),
  );
  const grabbed = grabEach(
    (chord) =>
      domicile.keyboard.grab(chord, { whileInhibited: inhibited.has(chord) }),
    [...names].filter((name) => !isGesture(name)),
  );
  const grabbedGestures = grabEach(
    (gesture) => domicile.gestures.grab(gesture),
    new Set(
      [...gesturesByMode.values()].flatMap((byGesture) =>
        byGesture.map(([gesture]) => grabOf(gesture)),
      ),
    ),
  );
  const stopShortcuts = domicile.keyboard.on("shortcut", ({ chord }) => {
    press(chord, bindings.get(mode)?.get(chord));
  });
  const stopReleases = domicile.keyboard.on("shortcutrelease", ({ chord }) => {
    release(chord);
  });
  const tracker = gestureTracker();
  const stopGestures = domicile.gestures.on("gesture", (gesture) => {
    onGesture(tracker.feed(gesture));
  });
  const commands = hearCommands(
    domicile.shell,
    help,
    describedBindings(bindings),
    onCommand,
    report,
  );
  return {
    setMode: (name) => {
      if (bindings.has(name)) {
        mode = name;
      } else {
        enter(DEFAULT_MODE);
      }
    },
    unbind: () => {
      stopShortcuts();
      stopReleases();
      for (const chord of [...armed.keys()]) {
        release(chord);
      }
      stopGestures();
      commands.stop();
      // Emptied, so a second unbind does not answer somebody else's grab.
      for (const chord of grabbed.splice(0)) {
        domicile.keyboard.ungrab(chord);
      }
      for (const gesture of grabbedGestures.splice(0)) {
        domicile.gestures.ungrab(gesture);
      }
    },
  };
};

/**
 * The action gesture `written` runs. A gesture runs its binding once it ends,
 * so it has no press and release to hold an action between.
 */
const gestureAction = (written: string, action: KeyAction): OneKeyAction => {
  switch (action.kind) {
    case KeyActionKind.Hold: {
      throw new Error(
        `domicile: gesture ${JSON.stringify(written)} cannot hold an action; only a chord has a press and a release`,
      );
    }
    case KeyActionKind.SendShell:
    case KeyActionKind.Exec:
    case KeyActionKind.Mode: {
      return action;
    }
  }
};

/**
 * Grab each of `names`, and return those the engine took. One it refuses,
 * such as a keysym the layout cannot type, is logged.
 */
const grabEach = (
  grab: (name: string) => void,
  names: Iterable<string>,
): string[] =>
  [...names].filter((name) => {
    try {
      grab(name);
      return true;
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: the user fixes a keysym the layout cannot type, so the shell reports it
      console.error(error);
      return false;
    }
  });

/**
 * Every binding, mode by mode, as `domicile list-bindings` prints it: the
 * chord in its one spelling and the action as words.
 */
export const describedBindings = (
  bindings: KeybindingsByMode,
): ShellBinding[] =>
  [...bindings].flatMap(([mode, chords]) =>
    [...chords].map(([chord, action]) => ({
      action: actionWords(action),
      chord,
      mode,
    })),
  );

/**
 * `action` as words: `send-shell focus left`, `exec foot`, `mode resize`, or
 * a hold.
 */
const actionWords = (action: KeyAction): string => {
  switch (action.kind) {
    case KeyActionKind.SendShell: {
      return ["send-shell", ...action.args].join(" ");
    }
    case KeyActionKind.Exec: {
      return ["exec", ...action.argv].join(" ");
    }
    case KeyActionKind.Mode: {
      return `mode ${action.name}`;
    }
    case KeyActionKind.Hold: {
      return `hold ${actionWords(action.press)} / ${actionWords(action.release)}`;
    }
  }
};

/** Log that a pressed binding's command was not run. */
const refusalToConsole = (why: string): void => {
  // biome-ignore lint/suspicious/noConsole: the user fixes a binding whose command the shell does not run, so the shell reports it
  console.error(why);
};

/** Log that `domicile send-shell` cannot reach this page. */
const reportToConsole = (error: SystemError): void => {
  // biome-ignore lint/suspicious/noConsole: the keys still work, and the console is where the shell says `domicile send-shell` cannot reach it
  console.error("this page cannot hear domicile send-shell", error);
};

/**
 * Run each command `domicile send-shell` sends through `onCommand` and answer
 * it, until `stop`. A stop before listening starts ends it once it does.
 */
const hearCommands = (
  shell: Pick<ShellNamespace, "commands" | "answer">,
  help: readonly ShellCommandHelp[],
  bound: readonly ShellBinding[],
  onCommand: (args: readonly string[]) => Result<CommandRan, string>,
  report: (error: SystemError) => void,
): { stop: () => void } => {
  const state: {
    stopped: boolean;
    listening: Listening<ShellCommand> | undefined;
  } = { listening: undefined, stopped: false };
  const runAndAnswer = ({ sent, words }: ShellCommand) => {
    shell
      .answer(sent, onCommand(words))
      .then((answered) => {
        answered.match({ Err: report, Ok: () => undefined });
      })
      .catch(reportToConsole);
  };
  shell
    .commands(help, bound)
    .then((result) => {
      result.match({
        Err: report,
        Ok: (listening) => {
          if (state.stopped) {
            listening.stop();
          } else {
            state.listening = listening;
          }
          eachOf(listening.items, runAndAnswer).catch(reportToConsole);
        },
      });
    })
    .catch(reportToConsole);
  return {
    stop: () => {
      state.stopped = true;
      state.listening?.stop();
    },
  };
};

/** Call `each` with every item `items` brings, until it closes. */
const eachOf = async <T>(
  items: ReadableStream<T>,
  each: (item: T) => void,
): Promise<void> => {
  for await (const item of items) {
    each(item);
  }
};
