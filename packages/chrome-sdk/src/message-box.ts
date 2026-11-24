// An Electron app window's message box: the box the engine lists on the
// window as JSON (`DomicileBrowserWindow.messageBox`), read into what a shell
// draws. See "Message boxes" in docs/SHELL-BROWSER-WINDOWS.md.

import { z } from "zod";

/** What kind of message it is, which a shell may show with an icon. */
export type MessageBoxKind = "none" | "info" | "error" | "question" | "warning";

export type MessageBox = {
  kind: MessageBoxKind;
  /** The app's title for the box, which Electron shows on its window bar. */
  title: string;
  /** The question or message. */
  message: string;
  /** More text under it, or empty for none. */
  detail: string;
  /** The buttons' labels, in the app's order. At least one. */
  buttons: readonly string[];
  /** The button Enter presses, or `undefined` for none. */
  defaultButton: number | undefined;
  /** The button Escape presses, and closing the window answers. */
  cancelButton: number;
  /** The checkbox's label, or `undefined` for no checkbox. */
  checkbox: string | undefined;
  /** Whether the checkbox starts checked. */
  checkboxChecked: boolean;
};

const writtenSchema = z.object({
  buttons: z.array(z.string()).min(1),
  cancelId: z.number().int().min(0),
  checkboxChecked: z.boolean(),
  checkboxLabel: z.string(),
  defaultId: z.number().int().min(-1),
  detail: z.string(),
  message: z.string(),
  title: z.string(),
  type: z.enum(["none", "info", "error", "question", "warning"]),
});

/**
 * The box `messageBox`, a browser window's `messageBox`, reads as. Throws for
 * a box the engine should not have listed: it checks each one the app sends.
 */
export const messageBox = (messageBox: string): MessageBox => {
  const written = writtenSchema.parse(JSON.parse(messageBox));
  const count = written.buttons.length;
  if (written.defaultId >= count || written.cancelId >= count) {
    throw new RangeError(
      `message box buttons out of range: default ${written.defaultId.toString()}, cancel ${written.cancelId.toString()} of ${count.toString()}`,
    );
  }
  return {
    buttons: written.buttons,
    cancelButton: written.cancelId,
    checkbox: written.checkboxLabel === "" ? undefined : written.checkboxLabel,
    checkboxChecked: written.checkboxChecked,
    defaultButton: written.defaultId === -1 ? undefined : written.defaultId,
    detail: written.detail,
    kind: written.type,
    message: written.message,
    title: written.title,
  };
};
