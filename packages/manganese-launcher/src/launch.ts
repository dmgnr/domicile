// The action for a chosen launcher row: run an app, open a file, ask what to
// open it with, or browse to a URL. `choices.ts` builds the rows.

/** The kind of launch. */
export enum LaunchKind {
  Ran,
  Opened,
  OpenedWith,
  Browsed,
}

export const Launch = {
  /**
   * Open `url` in a browser window on the desktop, private or not, in
   * browser profile `profile` or with none its site's.
   */
  Browsed: (url: string, isPrivate: boolean, profile?: string) => ({
    isPrivate,
    kind: LaunchKind.Browsed as const,
    profile,
    url,
  }),
  /**
   * Open `path` with the user's default application.
   *
   * Relative to home (as the host reports paths) or absolute. See
   * `open-command.ts` in window management.
   */
  Opened: (path: string) => ({ kind: LaunchKind.Opened as const, path }),
  /** Ask which application to open `path` with, as `Opened` reads it. */
  OpenedWith: (path: string) => ({
    kind: LaunchKind.OpenedWith as const,
    path,
  }),
  /** Run a desktop entry's argv, as the host parsed it. */
  Ran: (command: readonly string[]) => ({
    command,
    kind: LaunchKind.Ran as const,
  }),
};

export type Launch = ReturnType<(typeof Launch)[keyof typeof Launch]>;
