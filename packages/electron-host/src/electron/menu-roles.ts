/**
 * What the app's menu roles do to the focused window, as Electron's.
 *
 * @module
 */

import type { Role } from "./menu";

/** The Edit menu's roles, which act at the window's page's focus. */
export type EditRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "delete"
  | "selectAll";

/** What a role asks of a window: one of the app's BrowserWindows. */
export type RoleWindow = {
  readonly close: () => void;
  readonly isFullScreen: () => boolean;
  readonly minimize: () => void;
  readonly setFullScreen: (flag: boolean) => void;
  readonly webContents: Record<EditRole | "reload", () => void>;
};

/**
 * Each role a click can run, given the window it's over, or null when none is
 * focused, where it does nothing. `quit` quits the app. A role left out throws
 * when it's clicked: the zoom roles are, as the shell zooms pages.
 */
export const windowRoles = (quit: () => void) =>
  ({
    close: (window) => window?.close(),
    copy: (window) => window?.webContents.copy(),
    cut: (window) => window?.webContents.cut(),
    delete: (window) => window?.webContents.delete(),
    // The engine has no reload that skips the cache yet.
    forceReload: (window) => window?.webContents.reload(),
    minimize: (window) => window?.minimize(),
    paste: (window) => window?.webContents.paste(),
    pasteAndMatchStyle: (window) => window?.webContents.pasteAndMatchStyle(),
    quit: () => {
      quit();
    },
    redo: (window) => window?.webContents.redo(),
    reload: (window) => window?.webContents.reload(),
    selectAll: (window) => window?.webContents.selectAll(),
    togglefullscreen: (window) => window?.setFullScreen(!window.isFullScreen()),
    undo: (window) => window?.webContents.undo(),
  }) satisfies Partial<Record<Role, (window: RoleWindow | null) => void>>;
