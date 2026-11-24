// The clipboard's history, which the compositor keeps.

import type { DomicileClipboardEntry, DomicileHost } from "../domicile-host";
import { memoizeLast } from "./memoize-last";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";

/**
 * One copy: an id, whether it is an image, enough of it to recognize, for an
 * image a small picture of it as a `data:` URL, and whether it is what the
 * clipboard holds.
 */
export type ClipboardEntry = {
  readonly current: boolean;
  readonly id: number;
  readonly image: boolean;
  readonly preview: string;
  readonly thumbnail: string | undefined;
};

export type ClipboardListeners = {
  change: () => void;
};

export type Clipboard = {
  /** Newest first; `undefined` until the compositor says. */
  readonly entries: readonly ClipboardEntry[] | undefined;
  /** Put entry `id` back on the clipboard. An id since dropped sets nothing. */
  copy: (id: number) => void;
  on: On<ClipboardListeners>;
  /**
   * Drop entry `id` and its copy. Removing the current entry also empties the
   * clipboard. An id since dropped removes nothing.
   */
  remove: (id: number) => void;
};

export type ClipboardHost = Pick<
  DomicileHost,
  | "addEventListener"
  | "clipboard"
  | "copyClipboardEntry"
  | "removeClipboardEntry"
  | "removeEventListener"
>;

export const clipboard = (host: ClipboardHost): Clipboard => {
  const entriesOf = memoizeLast(
    (list: readonly DomicileClipboardEntry[] | null) => list?.map(entryOf),
  );
  return {
    copy: (id) => {
      host.copyClipboardEntry(id);
    },
    get entries() {
      return entriesOf(host.clipboard);
    },
    on: on<ClipboardListeners>({
      change: (listener) =>
        hostEvent(host, "clipboardchanged", () => listener()),
    }),
    remove: (id) => {
      host.removeClipboardEntry(id);
    },
  };
};

/** The engine sends `""` for a row with no thumbnail. */
const entryOf = (entry: DomicileClipboardEntry): ClipboardEntry => ({
  current: entry.current,
  id: entry.id,
  image: entry.image,
  preview: entry.preview,
  thumbnail: entry.thumbnail === "" ? undefined : entry.thumbnail,
});
