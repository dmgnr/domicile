// What the desk says to the shell itself: its options from the config,
// commands from `domicile send-shell`, and the links it claims.

import { z } from "zod";

import type { DomicileHost } from "../domicile-host";
import { memoizeLast } from "./memoize-last";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";
import type { System } from "./system-calls";

export type ShellListeners = {
  optionschange: () => void;
};

export type ShellNamespace = {
  /**
   * The config's `shell_options`, unchecked: `undefined` until the compositor
   * says. Check them against the shell's declaration with `watchShellOptions`.
   */
  readonly options: Readonly<Record<string, unknown>> | undefined;
  /**
   * Hear each command `domicile send-shell` sends, describing the commands
   * this page runs and the keys that run them. Answer each with `answer`.
   */
  commands: System["shellCommands"];
  /**
   * Say this page ran the command numbered `sent`, with what it printed if
   * anything, or why not.
   */
  answer: System["answerShellCommand"];
  /**
   * Open links of these schemes, such as `mailto`, for the desktop, instead
   * of the application that opens the scheme: hear each one `domicile open`
   * (and so `xdg-open` and applications' links) and the Email portal hand
   * over. The page that claimed a scheme last gets its links. Links a page
   * in a browser window opens arrive as `WEBVIEW_EXTERNAL_APP_EVENT` instead.
   */
  links: System["claimLinks"];
  on: On<ShellListeners>;
};

export type ShellHost = Pick<
  DomicileHost,
  "addEventListener" | "removeEventListener" | "shellOptions"
>;

export const shell = (
  host: ShellHost,
  calls: Pick<System, "shellCommands" | "answerShellCommand" | "claimLinks">,
): ShellNamespace => {
  const optionsOf = memoizeLast((text: string | null) =>
    text === null ? undefined : optionsSchema.parse(JSON.parse(text)),
  );
  return {
    answer: (sent, ran) => calls.answerShellCommand(sent, ran),
    commands: (help, bindings) => calls.shellCommands(help, bindings),
    links: (schemes) => calls.claimLinks(schemes),
    on: on<ShellListeners>({
      optionschange: (listener) =>
        hostEvent(host, "shelloptionschanged", () => listener()),
    }),
    get options() {
      return optionsOf(host.shellOptions);
    },
  };
};

const optionsSchema = z.record(z.string(), z.unknown());
