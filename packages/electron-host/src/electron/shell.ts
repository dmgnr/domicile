// The stand-in for Electron's `shell`: links and files open with
// `domicile open`, which picks the user's default app as the desktop does.
// Trashed items go to the desktop's trash, and a beep rings the compositor's
// bell for the shell to sound.

import { dirname } from "node:path";
import { Priority, say } from "../journal";

/** Runs a command, answering its exit code and what it printed. */
export type Run = (
  command: readonly string[],
) => Promise<{ readonly code: number; readonly output: string }>;

/** What the shell reaches on the desktop besides commands. */
export type ShellDesktop = {
  /** Moves `path` to the trash. */
  readonly trash: (path: string) => Promise<void>;
  /** Rings the compositor's bell, for no window. */
  readonly ringBell: () => Promise<void>;
};

/** Electron's `shell`, on Domicile. */
export const createShell = (run: Run, desktop: ShellDesktop) => {
  /** Opens `target` with `domicile open`: why it couldn't, or undefined. */
  const open = async (target: string) => {
    const { code, output } = await run(["domicile", "open", target]);
    if (code === 0) {
      return undefined;
    } else {
      const why = output.trim();
      return `couldn't open ${target}: ${why === "" ? `domicile open exited with ${code}` : why}`;
    }
  };

  return {
    beep: () => {
      desktop.ringBell().catch((error: unknown) => {
        // Electron's beep answers nothing, so the log is the only place
        // for why.
        say(
          Priority.Error,
          `electron-host: couldn't ring the bell: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    /** Opens `url` in the app the user opens its kind of link with. */
    openExternal: async (url: string, _options?: { activate?: boolean }) => {
      const why = await open(url);
      if (why !== undefined) {
        throw new Error(why);
      }
    },
    /** Opens a file with its default app: an empty string, or why it couldn't. */
    openPath: async (path: string) => (await open(path)) ?? "",
    /** Opens the folder `path` is in. */
    showItemInFolder: (path: string) => {
      open(dirname(path)).then(
        (why) => {
          if (why !== undefined) {
            // Electron's showItemInFolder answers nothing, so the log is
            // the only place for why.
            say(Priority.Error, `electron-host: ${why}`);
          }
        },
        (error: unknown) => {
          throw error;
        },
      );
    },
    trashItem: (path: string) => desktop.trash(path),
  };
};
