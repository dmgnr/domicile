// The stand-in for Electron's `clipboard`: the desktop's clipboard through
// `wl-paste` and `wl-copy`, which Domicile's compositor serves with its
// data-control protocols, so they work with no window focused
// (docs/use/CLIPBOARD.md). Electron's clipboard is synchronous, so each call
// waits on its command.
//
// `wl-copy` offers one type per copy, so a `write` of more than one format
// throws, naming the formats, rather than dropping some.
//
// Electron 44 made the clipboard ClipboardItems, read and written whole, and
// gave Linux `clipboard.selection` for the primary selection. `read()` with
// no format and `write` of an array are that API; the rest also answer as
// the earlier Electron's did, for apps written for it.

import type { NativeImage } from "./native-image";
import { nativeImage } from "./native-image";

/** A command's exit code and output. */
export type Ran = {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
};

/** How to run a command: what goes on its stdin, and whether to keep its stdout. */
export type RunOptions = {
  readonly input?: Uint8Array | undefined;
  /** False for `wl-copy`, which leaves a child serving the copy. */
  readonly output: boolean;
};

export type ClipboardDependencies = {
  /** Runs `command` and waits for it. */
  readonly run: (command: readonly string[], options: RunOptions) => Ran;
};

/** Electron's clipboard or, on Linux, the primary selection. */
export type ClipboardType = "clipboard" | "selection";

const TEXT = "text/plain;charset=utf-8";
/** `wl-paste`'s word for any text type the copy offers. */
const ANY_TEXT = "text";
const HTML = "text/html";
const RTF = "text/rtf";
const PNG = "image/png";

/** What `wl-paste` says when there's nothing to paste of a type. */
const NOTHING =
  /Nothing is copied|No selection|No suitable type of content copied/;

/** Electron's bookmark, which Linux keeps as its link. */
export type ClipboardBookmark = {
  readonly title: string;
  readonly url: string;
};

/** The type Electron names a bookmark by. */
const BOOKMARK = "electron application/bookmark";

/** What a `ClipboardItem` holds of one type. */
type ClipboardValue =
  | string
  | ClipboardBookmark
  | Blob
  | PromiseLike<Blob | string>;

/** Electron's `ClipboardItem`: one entry of the clipboard, by MIME type. */
export class ClipboardItem {
  readonly types: string[];
  readonly #items: Readonly<Record<string, ClipboardValue>>;

  constructor(items: Readonly<Record<string, ClipboardValue>>) {
    this.#items = { ...items };
    this.types = Object.keys(items);
  }

  /** The item's `type` as a Blob, or a bookmark's title and link. */
  getType(type: typeof BOOKMARK): Promise<ClipboardBookmark>;
  getType(type: string): Promise<Blob>;
  async getType(type: string): Promise<Blob | ClipboardBookmark> {
    const value = this.#items[type];
    if (value === undefined) {
      throw new Error(`The type ${type} is not in this ClipboardItem`);
    } else {
      const held = await value;
      return typeof held === "string" || held instanceof Blob
        ? new Blob([held], { type })
        : held;
    }
  }
}

/** `clipboard.read`: the whole clipboard's items, or one format's text. */
type Read = {
  (): Promise<ClipboardItem[]>;
  (format: string): string;
};

/** `clipboard.write`: whole items, or the earlier Electron's formats. */
type Write = {
  (items: readonly ClipboardItem[], type?: ClipboardType): Promise<void>;
  (data: ClipboardData, type?: ClipboardType): void;
};

export type ClipboardData = {
  text?: string | undefined;
  html?: string | undefined;
  image?: NativeImage | undefined;
  rtf?: string | undefined;
  bookmark?: string | undefined;
};

/** Builds Electron's `clipboard`. */
export const createClipboard = ({ run }: ClipboardDependencies) => {
  const primary = (type: ClipboardType | undefined) =>
    type === "selection" ? ["--primary"] : [];

  /** The command's stdout, or none when there's nothing of the type. */
  const paste = (args: readonly string[], type: ClipboardType | undefined) => {
    const ran = run(["wl-paste", ...primary(type), ...args], { output: true });
    if (ran.code === 0) {
      return ran.stdout;
    } else if (NOTHING.test(ran.stderr)) {
      return undefined;
    } else {
      throw new Error(
        `wl-paste failed, so the clipboard can't be read: ${ran.stderr.trim()}`,
      );
    }
  };

  const copy = (
    args: readonly string[],
    type: ClipboardType | undefined,
    input?: Uint8Array,
  ) => {
    const ran = run(["wl-copy", ...primary(type), ...args], {
      input,
      output: false,
    });
    if (ran.code !== 0) {
      throw new Error(
        `wl-copy failed, so the clipboard can't be written: ${ran.stderr.trim()}`,
      );
    }
  };

  const readType = (mime: string, type?: ClipboardType) =>
    paste(["--no-newline", "--type", mime], type)?.toString("utf8") ?? "";

  const writeType = (mime: string, data: Uint8Array, type?: ClipboardType) => {
    copy(["--type", mime], type, data);
  };

  const availableFormats = (type?: ClipboardType) =>
    (paste(["--list-types"], type)?.toString("utf8") ?? "")
      .split("\n")
      .filter((line) => line !== "");

  const writeText = (text: string, type?: ClipboardType) => {
    writeType(TEXT, Buffer.from(text), type);
  };

  const writeData = (data: ClipboardData, type?: ClipboardType) => {
    const formats = Object.entries(data).filter(
      ([, value]) => value !== undefined,
    );
    if (formats.length > 1) {
      throw new Error(
        `clipboard.write can't offer ${formats.map(([format]) => format).join(" and ")} at once on Domicile yet: wl-copy offers one type per copy`,
      );
    }
    const { bookmark, html, image, rtf, text } = data;
    if (text !== undefined) {
      writeText(text, type);
    } else if (html !== undefined) {
      writeType(HTML, Buffer.from(html), type);
    } else if (image !== undefined) {
      writeType(PNG, image.toPNG(), type);
    } else if (rtf !== undefined) {
      writeType(RTF, Buffer.from(rtf), type);
    } else if (bookmark !== undefined) {
      writeText(bookmark, type);
    }
  };

  /** What the clipboard holds as one item, each type pasted when asked. */
  const readItems = (type: ClipboardType | undefined) =>
    Promise.resolve().then(() => {
      const types = availableFormats(type);
      return types.length === 0
        ? []
        : [new PastedItem(types, (mime) => pasted(mime, type))];
    });

  /** `mime`'s bytes, which the clipboard listed as it was read. */
  const pasted = (mime: string, type: ClipboardType | undefined) => {
    const bytes = paste(["--type", mime], type);
    if (bytes === undefined) {
      throw new Error(`The clipboard no longer holds ${mime}`);
    } else {
      return new Blob([bytes], { type: mime });
    }
  };

  const writeItems = async (
    items: readonly ClipboardItem[],
    type: ClipboardType | undefined,
  ) => {
    const entries = items.flatMap((item) =>
      item.types.map((mime) => ({ item, mime })),
    );
    const [only, ...more] = entries;
    if (only === undefined) {
      copy(["--clear"], type);
    } else if (more.length > 0) {
      throw new Error(
        `clipboard.write can't offer ${entries.map(({ mime }) => mime).join(" and ")} at once on Domicile yet: wl-copy offers one type per copy`,
      );
    } else if (only.mime === BOOKMARK) {
      writeText((await only.item.getType(BOOKMARK)).url, type);
    } else {
      const held = await only.item.getType(only.mime);
      writeType(only.mime, new Uint8Array(await held.arrayBuffer()), type);
    }
  };

  const read: Read = ((format?: string) =>
    format === undefined ? readItems(undefined) : readType(format)) as Read;

  const write: Write = ((
    data: ClipboardData | readonly ClipboardItem[],
    type?: ClipboardType,
  ) =>
    isItems(data) ? writeItems(data, type) : writeData(data, type)) as Write;

  return {
    availableFormats,

    clear: (type?: ClipboardType) => {
      copy(["--clear"], type);
    },

    has: (format: string, type?: ClipboardType) =>
      availableFormats(type).includes(format),

    read,

    readBookmark: () => ({ title: "", url: "" }),

    readBuffer: (format: string) =>
      paste(["--type", format], undefined) ?? Buffer.alloc(0),

    /** A macOS pasteboard. */
    readFindText: () => "",

    readHTML: (type?: ClipboardType) => readType(HTML, type),

    readImage: (type?: ClipboardType) => {
      const png = paste(["--type", PNG], type);
      return png === undefined || png.length === 0
        ? nativeImage.createEmpty()
        : nativeImage.createFromBuffer(png);
    },

    readRTF: (type?: ClipboardType) => readType(RTF, type),

    readText: (type?: ClipboardType) => readType(ANY_TEXT, type),

    /** The primary selection, as Electron 44 gives it on Linux. */
    selection: {
      clear: () => {
        copy(["--clear"], "selection");
      },
      has: (mime: string) =>
        Promise.resolve().then(() =>
          availableFormats("selection").includes(mime),
        ),
      read: () => readItems("selection"),
      readText: () =>
        Promise.resolve().then(() => readType(ANY_TEXT, "selection")),
      write: (items: readonly ClipboardItem[]) =>
        writeItems(items, "selection"),
      writeText: (text: string) =>
        Promise.resolve().then(() => {
          writeText(text, "selection");
        }),
    },

    write,

    writeBookmark: (_title: string, url: string, type?: ClipboardType) => {
      writeText(url, type);
    },

    writeBuffer: (format: string, buffer: Uint8Array) => {
      writeType(format, buffer);
    },

    /** A macOS pasteboard. */
    writeFindText: (_text: string) => undefined,

    writeHTML: (markup: string, type?: ClipboardType) => {
      writeType(HTML, Buffer.from(markup), type);
    },

    writeImage: (image: NativeImage, type?: ClipboardType) => {
      writeType(PNG, image.toPNG(), type);
    },

    writeRTF: (text: string, type?: ClipboardType) => {
      writeType(RTF, Buffer.from(text), type);
    },

    writeText,
  };
};

const isItems = (
  data: ClipboardData | readonly ClipboardItem[],
): data is readonly ClipboardItem[] => Array.isArray(data);

/** An item `clipboard.read` gives: each of its types pasted when asked. */
class PastedItem extends ClipboardItem {
  readonly #paste: (mime: string) => Blob;

  constructor(types: readonly string[], paste: (mime: string) => Blob) {
    super(Object.fromEntries(types.map((mime) => [mime, ""])));
    this.#paste = paste;
  }

  override getType(type: typeof BOOKMARK): Promise<ClipboardBookmark>;
  override getType(type: string): Promise<Blob>;
  override getType(type: string): Promise<Blob | ClipboardBookmark> {
    return this.types.includes(type)
      ? Promise.resolve().then(() => this.#paste(type))
      : super.getType(type);
  }
}
