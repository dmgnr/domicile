// Electron's message boxes (`dialog.showMessageBox`), drawn by the shell over
// the window that asks: a `show_message_box` the engine answers with a
// `message_box_answered`. See "Desktop pieces" in
// docs/architecture/ELECTRON-APPS.md.

/** The most buttons the engine takes on one box. */
export const MOST_BUTTONS = 16;

export type MessageBoxType = "none" | "info" | "error" | "question" | "warning";

/** Electron's `MessageBoxOptions`, the parts a box over a window shows. */
export type MessageBoxOptions = {
  message: string;
  type?: MessageBoxType | undefined;
  buttons?: string[] | undefined;
  defaultId?: number | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  checkboxLabel?: string | undefined;
  checkboxChecked?: boolean | undefined;
  cancelId?: number | undefined;
  /** Electron's `noLink`, `icon`, `textWidth`, `signal`: not shown. */
  [unshown: string]: unknown;
};

/** Electron's `MessageBoxReturnValue`. */
export type MessageBoxReturnValue = {
  response: number;
  checkboxChecked: boolean;
};

/** A box as the engine takes it. */
export type ShowMessageBoxMessage = {
  readonly type: "show_message_box";
  readonly window: number;
  readonly box: number;
  readonly box_type: MessageBoxType;
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly default_id: number;
  readonly cancel_id: number;
  readonly checkbox_label: string;
  readonly checkbox_checked: boolean;
};

/** The engine's answer to a box. */
export type MessageBoxAnswered = {
  readonly type: "message_box_answered";
  readonly window: number;
  readonly box: number;
  readonly response: number;
  readonly checkbox_checked: boolean;
};

const inRange = (index: number | undefined, count: number) =>
  index !== undefined && Number.isInteger(index) && index >= 0 && index < count;

/**
 * Electron's cancel button when the app names none: the first labeled
 * "Cancel" or "No", else the first.
 */
const cancelOf = (buttons: readonly string[]) => {
  const found = buttons.findIndex((label) =>
    ["cancel", "no"].includes(label.replaceAll("&", "").trim().toLowerCase()),
  );
  return found === -1 ? 0 : found;
};

/**
 * `options` as the engine's box over `window`, numbered `box`. As Electron,
 * no buttons is one OK, which Enter presses, and a default or cancel past the
 * buttons is ignored. More buttons than the engine takes throws.
 */
export const boxFor = (
  window: number,
  box: number,
  options: MessageBoxOptions,
): ShowMessageBoxMessage => {
  const named = options.buttons ?? [];
  if (named.length > MOST_BUTTONS) {
    throw new RangeError(
      `dialog.showMessageBox takes at most ${MOST_BUTTONS.toString()} buttons on Domicile, and was given ${named.length.toString()}`,
    );
  }
  const buttons = named.length === 0 ? ["OK"] : named;
  const defaultId = named.length === 0 ? 0 : options.defaultId;
  return {
    box,
    box_type: options.type ?? "none",
    buttons,
    cancel_id: inRange(options.cancelId, buttons.length)
      ? (options.cancelId as number)
      : cancelOf(buttons),
    checkbox_checked: options.checkboxChecked ?? false,
    checkbox_label: options.checkboxLabel ?? "",
    default_id: inRange(defaultId, buttons.length) ? (defaultId as number) : -1,
    detail: options.detail ?? "",
    message: String(options.message),
    title: options.title ?? "",
    type: "show_message_box",
    window,
  };
};

/** Asks boxes of the engine and hears their answers. */
export const createMessageBoxes = (
  send: (message: ShowMessageBoxMessage) => void,
) => {
  const waiting = new Map<number, (answer: MessageBoxReturnValue) => void>();
  let next = 1;
  return {
    /** Shows `options` over `window`; resolves with the user's answer. */
    ask: (window: number, options: MessageBoxOptions) =>
      new Promise<MessageBoxReturnValue>((resolve) => {
        const box = next++;
        const message = boxFor(window, box, options);
        waiting.set(box, resolve);
        send(message);
      }),
    /** The engine answered a box. */
    hear: (answered: MessageBoxAnswered) => {
      const resolve = waiting.get(answered.box);
      if (resolve === undefined) {
        throw new Error(
          `the engine answered message box ${answered.box.toString()}, which nothing asked`,
        );
      }
      waiting.delete(answered.box);
      resolve({
        checkboxChecked: answered.checkbox_checked,
        response: answered.response,
      });
    },
  };
};

/**
 * The window a message box goes over: the one the app named, else its most
 * recent window with a page, or none when no window has one: the engine
 * shows a box only over a window's page.
 */
export const boxWindow = (
  named: unknown,
  windows: {
    getAllWindows: () => {
      id: number;
      isDestroyed: () => boolean;
      isOpen: () => boolean;
    }[];
  },
): number | undefined => {
  const shown = windows
    .getAllWindows()
    .filter((window) => !window.isDestroyed() && window.isOpen());
  if (named !== undefined && named !== null) {
    const { id } = named as { id: unknown };
    if (typeof id !== "number") {
      throw new TypeError(
        "dialog.showMessageBox takes a BrowserWindow, then its options",
      );
    }
    if (shown.some((window) => window.id === id)) {
      return id;
    }
  }
  return shown.at(-1)?.id;
};
