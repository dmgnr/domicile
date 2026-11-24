// The action a keybinding runs: a shell command, a program, a binding mode
// change, or a pair of them held between a press and its release.

/** The kind of action a binding runs. */
export enum KeyActionKind {
  SendShell,
  Exec,
  Mode,
  Hold,
}

/** The actions one key event runs. */
const OneKeyAction = {
  /**
   * Start a program, as `domicile exec` does: `argv[0]` found on the
   * desktop's `PATH`, without a shell. The SDK starts it; the shell hears
   * nothing. The desktop tells the person when it does not start.
   */
  Exec: (argv: readonly string[]) => ({
    argv,
    kind: KeyActionKind.Exec as const,
  }),
  /**
   * Switch to another binding mode. The SDK handles this itself and tells the
   * shell the mode changed.
   */
  Mode: (name: string) => ({ kind: KeyActionKind.Mode as const, name }),
  /**
   * A command for the shell, as the arguments `domicile send-shell` would
   * pass. The shell defines what they mean.
   */
  SendShell: (args: readonly string[]) => ({
    args,
    kind: KeyActionKind.SendShell as const,
  }),
};

/** An action one key event runs. */
export type OneKeyAction = ReturnType<
  (typeof OneKeyAction)[keyof typeof OneKeyAction]
>;

export const KeyAction = {
  ...OneKeyAction,
  /**
   * Run `press` when the chord is pressed and `release` when it is let go.
   * The release runs whatever binding mode the keys are in by then, and runs
   * once per press however long the key repeats.
   */
  Hold: (press: OneKeyAction, release: OneKeyAction) => ({
    kind: KeyActionKind.Hold as const,
    press,
    release,
  }),
};

export type KeyAction = ReturnType<(typeof KeyAction)[keyof typeof KeyAction]>;
