import { describe, expect, it } from "bun:test";

import { encodePng } from "../png";
import type { Ran, RunOptions } from "./clipboard";
import { ClipboardItem, createClipboard } from "./clipboard";
import { nativeImage } from "./native-image";

const PNG = Buffer.from(
  encodePng({ height: 1, rgba: new Uint8Array([1, 2, 3, 4]), width: 1 }),
);

/** A desktop clipboard holding `held` (type → bytes), as wl-paste reads it. */
const setUp = (held: Record<string, Buffer> = {}) => {
  const ran: { command: readonly string[]; options: RunOptions }[] = [];
  const clipboard = createClipboard({
    run: (command, options): Ran => {
      ran.push({ command, options });
      if (command[0] === "wl-copy") {
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      }
      if (command.includes("--list-types")) {
        const types = Object.keys(held);
        return types.length === 0
          ? { code: 1, stderr: "Nothing is copied\n", stdout: Buffer.alloc(0) }
          : {
              code: 0,
              stderr: "",
              stdout: Buffer.from(`${types.join("\n")}\n`),
            };
      }
      const wanted = command[command.indexOf("--type") + 1] ?? "";
      const found = Object.entries(held).find(([type]) =>
        wanted === "text" ? type.startsWith("text/plain") : type === wanted,
      );
      return found === undefined
        ? {
            code: 1,
            stderr: "No suitable type of content copied\n",
            stdout: Buffer.alloc(0),
          }
        : { code: 0, stderr: "", stdout: found[1] };
    },
  });
  return { clipboard, ran };
};

describe("reading", () => {
  it("reads text, HTML and images, as Electron's types", () => {
    const { clipboard } = setUp({
      "image/png": PNG,
      "text/html": Buffer.from("<b>hi</b>"),
      "text/plain": Buffer.from("hi"),
    });

    expect(clipboard.readText()).toBe("hi");
    expect(clipboard.readHTML()).toBe("<b>hi</b>");
    expect(clipboard.readImage().getSize()).toEqual({ height: 1, width: 1 });
    expect(clipboard.availableFormats()).toEqual([
      "image/png",
      "text/html",
      "text/plain",
    ]);
    expect(clipboard.has("text/html")).toBe(true);
    expect(clipboard.readBuffer("text/html").toString()).toBe("<b>hi</b>");
  });

  it("reads nothing from an empty clipboard, as Electron does", () => {
    const { clipboard } = setUp();

    expect(clipboard.readText()).toBe("");
    expect(clipboard.readImage().isEmpty()).toBe(true);
    expect(clipboard.availableFormats()).toEqual([]);
  });

  it("reads the primary selection when asked", () => {
    const { clipboard, ran } = setUp({ "text/plain": Buffer.from("hi") });

    clipboard.readText("selection");

    expect(ran[0]?.command).toEqual([
      "wl-paste",
      "--primary",
      "--no-newline",
      "--type",
      "text",
    ]);
  });

  it("says why when wl-paste fails", () => {
    const clipboard = createClipboard({
      run: () => ({
        code: 1,
        stderr: "Failed to connect to a Wayland server\n",
        stdout: Buffer.alloc(0),
      }),
    });

    expect(() => clipboard.readText()).toThrow(
      "wl-paste failed, so the clipboard can't be read: Failed to connect",
    );
  });
});

describe("writing", () => {
  it("copies each format with its type, keeping no output", () => {
    const { clipboard, ran } = setUp();

    clipboard.writeText("hi");
    clipboard.writeHTML("<b>hi</b>", "selection");
    clipboard.writeImage(nativeImage.createFromBuffer(PNG));
    clipboard.clear();

    expect(ran.map(({ command }) => command)).toEqual([
      ["wl-copy", "--type", "text/plain;charset=utf-8"],
      ["wl-copy", "--primary", "--type", "text/html"],
      ["wl-copy", "--type", "image/png"],
      ["wl-copy", "--clear"],
    ]);
    expect(ran[0]?.options).toEqual({
      input: Buffer.from("hi"),
      output: false,
    });
    expect(Buffer.compare(Buffer.from(ran[2]?.options.input ?? []), PNG)).toBe(
      0,
    );
  });

  it("writes one format, and refuses several rather than dropping some", () => {
    const { clipboard, ran } = setUp();

    expect(clipboard.write({ text: "hi" })).toBeUndefined();
    expect(ran[0]?.command).toEqual([
      "wl-copy",
      "--type",
      "text/plain;charset=utf-8",
    ]);
    expect(() => clipboard.write({ html: "<b>hi</b>", text: "hi" })).toThrow(
      "can't offer html and text at once",
    );
  });

  it("says why when wl-copy fails", () => {
    const clipboard = createClipboard({
      run: () => ({
        code: 1,
        stderr: "wl-copy: not found\n",
        stdout: Buffer.alloc(0),
      }),
    });

    expect(() => clipboard.writeText("hi")).toThrow(
      "wl-copy failed, so the clipboard can't be written: wl-copy: not found",
    );
  });
});

describe("Electron 44's clipboard of ClipboardItems", () => {
  it("reads what the clipboard holds as one item, each type pasted when asked", async () => {
    const { clipboard, ran } = setUp({
      "text/html": Buffer.from("<b>hi</b>"),
      "text/plain": Buffer.from("hi"),
    });

    const items = await clipboard.read();
    expect(items.map(({ types }) => types)).toEqual([
      ["text/html", "text/plain"],
    ]);
    expect(ran).toHaveLength(1);
    expect(await (await items[0]?.getType("text/html"))?.text()).toBe(
      "<b>hi</b>",
    );
    expect(items[0]?.getType("image/png")).rejects.toThrow(
      "The type image/png is not in this ClipboardItem",
    );
  });

  it("reads no items from an empty clipboard", async () => {
    const { clipboard } = setUp();

    expect(await clipboard.read()).toEqual([]);
  });

  it("writes an item's one type, and refuses several rather than dropping some", async () => {
    const { clipboard, ran } = setUp();

    await clipboard.write([
      new ClipboardItem({ "text/html": Promise.resolve("<b>hi</b>") }),
    ]);
    expect(ran.map(({ command }) => command)).toEqual([
      ["wl-copy", "--type", "text/html"],
    ]);
    expect(ran[0]?.options.input).toEqual(Buffer.from("<b>hi</b>"));
    expect(
      clipboard.write([
        new ClipboardItem({ "text/html": "<b>hi</b>", "text/plain": "hi" }),
      ]),
    ).rejects.toThrow("can't offer text/html and text/plain at once");
  });

  it("writes a bookmark as its link, as Linux has no bookmarks", async () => {
    const { clipboard, ran } = setUp();

    await clipboard.write([
      new ClipboardItem({
        "electron application/bookmark": { title: "A", url: "https://a/" },
      }),
    ]);

    expect(ran[0]?.command).toEqual([
      "wl-copy",
      "--type",
      "text/plain;charset=utf-8",
    ]);
    expect(ran[0]?.options.input).toEqual(Buffer.from("https://a/"));
  });

  it("works the primary selection through clipboard.selection", async () => {
    const { clipboard, ran } = setUp({ "text/plain": Buffer.from("hi") });

    expect(await clipboard.selection.readText()).toBe("hi");
    expect(await clipboard.selection.has("text/plain")).toBe(true);
    await clipboard.selection.writeText("there");
    clipboard.selection.clear();
    await clipboard.selection.read();

    expect(ran.map(({ command }) => command[1])).toEqual([
      "--primary",
      "--primary",
      "--primary",
      "--primary",
      "--primary",
    ]);
  });
});

describe(ClipboardItem, () => {
  it("names its types and gives each as a Blob", async () => {
    const item = new ClipboardItem({
      "image/png": new Blob([PNG]),
      "text/plain": "hi",
    });

    expect(item.types).toEqual(["image/png", "text/plain"]);
    expect(await (await item.getType("text/plain")).text()).toBe("hi");
    expect((await item.getType("image/png")).type).toBe("image/png");
  });
});
