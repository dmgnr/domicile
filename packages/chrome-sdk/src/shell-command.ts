// The commands `domicile send-shell` sends a shell, how a shell describes the
// ones it runs for `domicile list-shell-commands` and the keys that run them
// for `domicile list-bindings`, and how it answers each. See
// docs/architecture/KEYBINDINGS.md. Also the links `domicile open` hands a
// shell that claims their scheme; see docs/WRITING-A-SHELL.md#links.

/** One command a shell runs, as `domicile list-shell-commands` prints it. */
export type ShellCommandHelp = {
  /** Its words, such as `focus left|right|up|down` or `workspace <name>`. */
  readonly usage: string;
  /** What it does, in a sentence. */
  readonly description: string;
};

/** A command `domicile send-shell` sent, for the page to run and answer. */
export type ShellCommand = {
  /** The words after `send-shell`. */
  readonly words: readonly string[];
  /** Its number, which `answerShellCommand` names. */
  readonly sent: number;
};

/** One key or gesture a shell binds, as `domicile list-bindings` prints it. */
export type ShellBinding = {
  /** The binding mode it is in; `default` until a binding changes mode. */
  readonly mode: string;
  /** The chord or gesture, in the SDK's one spelling (`Meta+Shift+l`). */
  readonly chord: string;
  /** What it runs, as words: `send-shell focus left` or `mode resize`. */
  readonly action: string;
};

/**
 * A command the shell ran: `"ran"`, or with `output` for
 * `domicile send-shell` to print, such as a query's JSON.
 */
export type CommandRan = "ran" | { readonly output: string };

/**
 * A link handed to the shell because it claims the link's scheme: from
 * `domicile open` (and so `xdg-open` and applications' links) or the Email
 * portal.
 */
export type Link = {
  /** The link, such as `mailto:a@example.com?subject=Hi`. */
  readonly url: string;
  /** The desktop file id of the application that asked, when known. */
  readonly appId: string | undefined;
};
