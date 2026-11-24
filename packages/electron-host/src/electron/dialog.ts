// The stand-in for Electron's `dialog`: file dialogs through the desktop's
// file chooser portal, as Electron uses on Linux when the portal is there
// (docs/PORTALS.md). Message boxes are drawn by the shell over the window that
// asks (message-boxes.ts).

import { basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { MessageBoxOptions, MessageBoxReturnValue } from "./message-boxes";

/** A portal option's D-Bus signature and value. */
export type ChooserOption = readonly [signature: string, value: unknown];

export type ChooserOptions = Readonly<Record<string, ChooserOption>>;

/** What the portal answered: 0 for a choice, else canceled. */
export type ChooserAnswer = {
  readonly response: number;
  readonly uris: readonly string[];
};

export type ChooserMethod = "OpenFile" | "SaveFile";

/** What the dialogs need of the desktop. */
export type DialogDependencies = {
  /** Asks the file chooser portal. */
  readonly choose: (
    method: ChooserMethod,
    title: string,
    options: ChooserOptions,
  ) => Promise<ChooserAnswer>;
  /** The same, blocking until the user answers, for the `Sync` calls. */
  readonly chooseSync: (
    method: ChooserMethod,
    title: string,
    options: ChooserOptions,
  ) => ChooserAnswer;
  readonly isDirectory: (path: string) => boolean;
  /**
   * Shows a message box over `window`, the window the app named, or its most
   * recent one when it named none.
   */
  readonly askMessageBox: (
    window: unknown,
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue>;
  /** Where `showErrorBox` writes. */
  readonly printError: (text: string) => void;
};

export type FileFilter = { name: string; extensions: string[] };

type OpenDialogProperty =
  | "openFile"
  | "openDirectory"
  | "multiSelections"
  | "showHiddenFiles"
  | "createDirectory"
  | "promptToCreate"
  | "noResolveAliases"
  | "treatPackageAsDirectory"
  | "dontAddToRecent";

export type OpenDialogOptions = {
  title?: string | undefined;
  defaultPath?: string | undefined;
  buttonLabel?: string | undefined;
  filters?: FileFilter[] | undefined;
  properties?: OpenDialogProperty[] | undefined;
  message?: string | undefined;
};

export type SaveDialogOptions = {
  title?: string | undefined;
  defaultPath?: string | undefined;
  buttonLabel?: string | undefined;
  filters?: FileFilter[] | undefined;
  message?: string | undefined;
  nameFieldLabel?: string | undefined;
  properties?: string[] | undefined;
};

/** A NUL-ended byte string, as the portal takes paths. */
const pathBytes = (path: string) => [...Buffer.from(`${path}\0`)];

/** Electron's filters as the portal's: globs, `*` for all files. */
const portalFilters = (filters: readonly FileFilter[]) =>
  filters.map(({ extensions, name }) => [
    name,
    extensions.map((extension) => [
      0,
      extension === "*" ? "*" : `*.${extension}`,
    ]),
  ]);

/** Options both dialogs share. */
const sharedOptions = (
  options: OpenDialogOptions | SaveDialogOptions,
): Record<string, ChooserOption> => ({
  ...(options.buttonLabel === undefined
    ? {}
    : { accept_label: ["s", options.buttonLabel] }),
  ...(options.filters === undefined || options.filters.length === 0
    ? {}
    : { filters: ["a(sa(us))", portalFilters(options.filters)] }),
});

/** `path` if it's a folder, else the folder it's in. */
const folderOf = (path: string, isDirectory: (path: string) => boolean) =>
  isDirectory(path) ? path : dirname(path);

/** The portal's options for an open dialog. */
export const openOptions = (
  options: OpenDialogOptions,
  isDirectory: (path: string) => boolean,
): ChooserOptions => {
  const properties = options.properties ?? ["openFile"];
  const { defaultPath } = options;
  const folder =
    defaultPath === undefined || defaultPath === ""
      ? undefined
      : folderOf(defaultPath, isDirectory);
  return {
    ...sharedOptions(options),
    directory: ["b", properties.includes("openDirectory")],
    multiple: ["b", properties.includes("multiSelections")],
    ...(folder === undefined
      ? {}
      : { current_folder: ["ay", pathBytes(folder)] }),
  };
};

/** The portal's options for a save dialog. */
export const saveOptions = (
  options: SaveDialogOptions,
  isDirectory: (path: string) => boolean,
): ChooserOptions => {
  const { defaultPath } = options;
  const where: Record<string, ChooserOption> = {};
  if (defaultPath !== undefined && defaultPath !== "") {
    if (isAbsolute(defaultPath) && isDirectory(defaultPath)) {
      where.current_folder = ["ay", pathBytes(defaultPath)];
    } else {
      if (isAbsolute(defaultPath)) {
        where.current_folder = ["ay", pathBytes(dirname(defaultPath))];
      }
      where.current_name = ["s", basename(defaultPath)];
    }
  }
  return { ...sharedOptions(options), ...where };
};

/** The paths chosen, or none for a canceled dialog. */
const chosen = ({ response, uris }: ChooserAnswer) =>
  response === 0 ? uris.map((uri) => fileURLToPath(uri)) : [];

/** Electron's `(window, options)` or `(options)`. */
const optionsOf = <Options>(first: unknown, second: Options | undefined) =>
  (second ?? first ?? {}) as Options;

const openResult = (answer: ChooserAnswer) => {
  const filePaths = chosen(answer);
  return { canceled: filePaths.length === 0, filePaths };
};

const saveResult = (answer: ChooserAnswer) => {
  const [filePath = ""] = chosen(answer);
  return { canceled: filePath === "", filePath };
};

/** Electron's `(window, options)` or `(options)`: the window, if named. */
const windowOf = (first: unknown, second: unknown) =>
  second === undefined ? undefined : first;

/** Builds Electron's `dialog` module. */
export const createDialog = (dependencies: DialogDependencies) => {
  const open = (options: OpenDialogOptions) =>
    [
      "OpenFile",
      options.title ?? "Open",
      openOptions(options, dependencies.isDirectory),
    ] as const;
  const save = (options: SaveDialogOptions) =>
    [
      "SaveFile",
      options.title ?? "Save",
      saveOptions(options, dependencies.isDirectory),
    ] as const;

  return {
    showErrorBox: (title: string, content: string) => {
      dependencies.printError(`${title}\n${content}`);
    },
    showMessageBox: (first: unknown, second?: MessageBoxOptions) =>
      dependencies.askMessageBox(
        windowOf(first, second),
        optionsOf<MessageBoxOptions>(first, second),
      ),
    /**
     * Throws: the shell answers a box while the app's main process runs on,
     * so nothing can block for it.
     */
    showMessageBoxSync: (_first: unknown, _second?: unknown): number => {
      throw new Error(
        "dialog.showMessageBoxSync can't wait for the shell's answer on Domicile; use dialog.showMessageBox",
      );
    },
    showOpenDialog: async (first: unknown, second?: OpenDialogOptions) =>
      openResult(await dependencies.choose(...open(optionsOf(first, second)))),
    showOpenDialogSync: (first: unknown, second?: OpenDialogOptions) => {
      const { canceled, filePaths } = openResult(
        dependencies.chooseSync(...open(optionsOf(first, second))),
      );
      return canceled ? undefined : filePaths;
    },
    showSaveDialog: async (first: unknown, second?: SaveDialogOptions) =>
      saveResult(await dependencies.choose(...save(optionsOf(first, second)))),
    showSaveDialogSync: (first: unknown, second?: SaveDialogOptions) => {
      const { canceled, filePath } = saveResult(
        dependencies.chooseSync(...save(optionsOf(first, second))),
      );
      return canceled ? undefined : filePath;
    },
  };
};
