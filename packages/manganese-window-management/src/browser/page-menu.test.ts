import { describe, expect, it } from "bun:test";
import { BrowserCommand } from "./browser-command";
import type { PageContext } from "./page-menu";
import {
  choosePageCommand,
  MediaKind,
  PageMenuCommand,
  pageContextOf,
  pageMenuFor,
} from "./page-menu";

/** A right click over nothing in particular, with every flag down. */
const plain = (overrides: Partial<PageContext> = {}): PageContext => ({
  can: {
    copy: false,
    cut: false,
    delete: false,
    paste: false,
    redo: false,
    selectAll: false,
    undo: false,
  },
  editable: false,
  hasPixels: false,
  link: undefined,
  media: MediaKind.None,
  misspelling: undefined,
  pictureInPicture: { active: false, can: false },
  replaceMisspelling: () => undefined,
  run: () => undefined,
  selection: "",
  source: undefined,
  x: 0,
  y: 0,
  ...overrides,
});

const page = { canGoBack: true, canGoForward: false, zoom: 1 };

/** The commands a menu offers, group by group, and which are grayed out. */
const commandsOf = (context: PageContext) =>
  pageMenuFor(context, page).map((group) =>
    group.map((item) => (item.disabled ? `(${item.command})` : item.command)),
  );

/** An event as the engine dispatches it, built since no DOM here has one. */
const event = (fields: Partial<DomicileContextMenuEvent>) =>
  Object.assign(new Event("domicile-context-menu"), {
    canCopy: false,
    canCut: false,
    canDelete: false,
    canPaste: false,
    canPictureInPicture: false,
    canRedo: false,
    canSelectAll: false,
    canUndo: false,
    hasImageContents: false,
    inPictureInPicture: false,
    isEditable: false,
    linkText: "",
    linkUrl: "",
    mediaType: "none",
    misspelledWord: "",
    replaceMisspelling: () => undefined,
    run: () => undefined,
    selectionText: "",
    spellingSuggestions: [],
    srcUrl: "",
    x: 0,
    y: 0,
    ...fields,
  }) as DomicileContextMenuEvent;

describe("pageContextOf", () => {
  it("reads what was under the click off the engine's event", () => {
    const context = pageContextOf(
      event({
        hasImageContents: true,
        linkUrl: "https://example.test/opened",
        mediaType: "image",
        srcUrl: "https://example.test/picture.png",
        x: 12,
        y: 34,
      }),
    );
    expect(context.link).toBe("https://example.test/opened");
    expect(context.source).toBe("https://example.test/picture.png");
    expect(context.media).toBe(MediaKind.Image);
    expect(context.hasPixels).toBe(true);
    expect([context.x, context.y]).toEqual([12, 34]);
  });

  it("reads an empty address as none", () => {
    const context = pageContextOf(event({}));
    expect(context.link).toBeUndefined();
    expect(context.source).toBeUndefined();
  });

  it("refuses a media type it has never heard of", () => {
    expect(() => pageContextOf(event({ mediaType: "hologram" }))).toThrow();
  });

  it("reads whether a video can go into picture-in-picture, and is in it", () => {
    const context = pageContextOf(
      event({
        canPictureInPicture: true,
        inPictureInPicture: true,
        mediaType: "video",
      }),
    );
    expect(context.pictureInPicture).toEqual({ active: true, can: true });
  });

  it("reads a misspelled word and what it could be", () => {
    const context = pageContextOf(
      event({
        misspelledWord: "recieve",
        spellingSuggestions: ["receive", "relieve"],
      }),
    );
    expect(context.misspelling).toEqual({
      suggestions: ["receive", "relieve"],
      word: "recieve",
    });
  });

  it("reads no misspelled word as none", () => {
    expect(pageContextOf(event({})).misspelling).toBeUndefined();
  });

  it("hands a replacement back to the event it came from", async () => {
    const replaced = await new Promise<string>((resolve) => {
      pageContextOf(
        event({ misspelledWord: "recieve", replaceMisspelling: resolve }),
      ).replaceMisspelling("receive");
    });
    expect(replaced).toBe("receive");
  });

  it("hands an action back to the event it came from", async () => {
    const ran = await new Promise<string>((resolve) => {
      pageContextOf(event({ run: resolve })).run("copy-link-address");
    });
    expect(ran).toBe("copy-link-address");
  });
});

describe("pageMenuFor", () => {
  it("offers a page's history and DevTools over nothing in particular", () => {
    expect(commandsOf(plain())).toEqual([
      [
        PageMenuCommand.Back,
        `(${PageMenuCommand.Forward})`,
        PageMenuCommand.Reload,
      ],
      [PageMenuCommand.ZoomIn, PageMenuCommand.ZoomOut],
      [PageMenuCommand.Inspect],
    ]);
  });

  it("offers to reset the zoom only when the page is zoomed", () => {
    expect(pageMenuFor(plain(), { ...page, zoom: 1.25 })[1]).toContainEqual({
      command: PageMenuCommand.ZoomReset,
      disabled: false,
      label: "Reset zoom",
      shortcut: "Ctrl+0",
    });
  });

  it("grays out zooming past either end", () => {
    const zoomsAt = (zoom: number) =>
      pageMenuFor(plain(), { ...page, zoom })[1]
        ?.slice(0, 2)
        .map((item) => item.disabled);
    expect(zoomsAt(5)).toEqual([true, false]);
    expect(zoomsAt(0.25)).toEqual([false, true]);
  });

  it("names the history and zoom chords beside their commands", () => {
    expect(
      pageMenuFor(plain(), page)
        .slice(0, 2)
        .map((group) => group.map((item) => item.shortcut)),
    ).toEqual([
      ["Alt+←", "Alt+→", "Ctrl+R"],
      ["Ctrl++", "Ctrl+−"],
    ]);
  });

  it("offers a link's commands over a link", () => {
    expect(commandsOf(plain({ link: "https://example.test/" }))).toEqual([
      [
        PageMenuCommand.OpenLink,
        PageMenuCommand.SaveLinkAs,
        PageMenuCommand.CopyLinkAddress,
      ],
      [PageMenuCommand.Inspect],
    ]);
  });

  it("offers an image's commands over an image", () => {
    expect(
      commandsOf(
        plain({
          hasPixels: true,
          media: MediaKind.Image,
          source: "https://example.test/picture.png",
        }),
      ),
    ).toEqual([
      [
        PageMenuCommand.OpenMedia,
        PageMenuCommand.SaveMediaAs,
        PageMenuCommand.CopyImage,
        PageMenuCommand.CopyMediaAddress,
      ],
      [PageMenuCommand.Inspect],
    ]);
  });

  it("offers both over an image in a link", () => {
    expect(
      commandsOf(
        plain({
          hasPixels: true,
          link: "https://example.test/",
          media: MediaKind.Image,
          source: "https://example.test/picture.png",
        }),
      ),
    ).toHaveLength(3);
  });

  it("copies no pixels of a broken image", () => {
    expect(
      commandsOf(
        plain({
          media: MediaKind.Image,
          source: "https://example.test/picture.png",
        }),
      )[0],
    ).not.toContain(PageMenuCommand.CopyImage);
  });

  it("names a video's commands for a video", () => {
    const [media] = pageMenuFor(
      plain({
        media: MediaKind.Video,
        source: "https://example.test/film.webm",
      }),
      page,
    );
    expect(media?.map((item) => item.label)).toEqual([
      "Open video in new window",
      "Save video as…",
      "Copy video address",
    ]);
  });

  it("puts a video that can go into picture-in-picture there", () => {
    const [media] = pageMenuFor(
      plain({
        media: MediaKind.Video,
        pictureInPicture: { active: false, can: true },
        source: "https://example.test/film.webm",
      }),
      page,
    );
    expect(media?.at(-1)).toEqual({
      command: PageMenuCommand.PictureInPicture,
      disabled: false,
      label: "Picture in picture",
      shortcut: undefined,
    });
  });

  it("takes a video in picture-in-picture out", () => {
    const [media] = pageMenuFor(
      plain({
        media: MediaKind.Video,
        pictureInPicture: { active: true, can: true },
      }),
      page,
    );
    expect(media?.map((item) => item.label)).toEqual([
      "Exit picture in picture",
    ]);
  });

  it("saves and copies a canvas, which has no address", () => {
    expect(
      commandsOf(plain({ hasPixels: true, media: MediaKind.Canvas }))[0],
    ).toEqual([PageMenuCommand.SaveMediaAs, PageMenuCommand.CopyImage]);
  });

  it("offers editing in a field, grayed out where the page says it cannot", () => {
    expect(
      commandsOf(
        plain({
          can: {
            copy: false,
            cut: false,
            delete: false,
            paste: true,
            redo: false,
            selectAll: true,
            undo: true,
          },
          editable: true,
        }),
      ),
    ).toEqual([
      [PageMenuCommand.Undo, `(${PageMenuCommand.Redo})`],
      [
        `(${PageMenuCommand.Cut})`,
        `(${PageMenuCommand.Copy})`,
        PageMenuCommand.Paste,
        PageMenuCommand.PasteAsPlainText,
        `(${PageMenuCommand.Delete})`,
        PageMenuCommand.SelectAll,
      ],
      [PageMenuCommand.Inspect],
    ]);
  });

  it("puts a misspelled word's fixes above the rest of a field's menu", () => {
    const groups = pageMenuFor(
      plain({
        editable: true,
        misspelling: { suggestions: ["receive", "relieve"], word: "recieve" },
      }),
      page,
    );
    expect(
      groups[0]?.map(({ command, label, replacement }) => ({
        command,
        label,
        replacement,
      })),
    ).toEqual([
      {
        command: PageMenuCommand.ReplaceMisspelling,
        label: "receive",
        replacement: "receive",
      },
      {
        command: PageMenuCommand.ReplaceMisspelling,
        label: "relieve",
        replacement: "relieve",
      },
      {
        command: PageMenuCommand.AddToDictionary,
        label: "Add to dictionary",
        replacement: undefined,
      },
    ]);
    expect(groups[1]?.map(({ command }) => command)).toEqual([
      PageMenuCommand.Undo,
      PageMenuCommand.Redo,
    ]);
  });

  it("says so when a misspelled word has no suggestions", () => {
    expect(
      commandsOf(
        plain({
          editable: true,
          misspelling: { suggestions: [], word: "zorblax" },
        }),
      )[0],
    ).toEqual([
      `(${PageMenuCommand.NoSpellingSuggestions})`,
      PageMenuCommand.AddToDictionary,
    ]);
  });

  it("copies and searches for a selection outside a field", () => {
    const [selected] = pageMenuFor(
      plain({ can: { ...plain().can, copy: true }, selection: "domicile" }),
      page,
    );
    expect(selected?.map((item) => item.command)).toEqual([
      PageMenuCommand.Copy,
      PageMenuCommand.Search,
    ]);
    expect(selected?.[1]?.label).toBe("Search for “domicile”");
  });

  it("shortens a long selection in its label", () => {
    const [selected] = pageMenuFor(plain({ selection: "a".repeat(100) }), page);
    expect(selected?.[1]?.label).toBe(`Search for “${"a".repeat(40)}…”`);
  });

  it("names DevTools' chord beside Inspect", () => {
    const inspect = pageMenuFor(plain(), page).at(-1)?.[0];
    expect(inspect?.shortcut).toBe("Ctrl+Shift+I");
  });
});

describe("choosePageCommand", () => {
  it("zooms the way the window's chords do", () => {
    const browsed: BrowserCommand[] = [];
    const window = {
      browse: (command: BrowserCommand) => {
        browsed.push(command);
      },
      openWindow: () => undefined,
    };
    choosePageCommand({ command: PageMenuCommand.ZoomIn }, plain(), window);
    choosePageCommand({ command: PageMenuCommand.ZoomOut }, plain(), window);
    choosePageCommand({ command: PageMenuCommand.ZoomReset }, plain(), window);
    expect(browsed).toEqual([
      BrowserCommand.ZoomIn,
      BrowserCommand.ZoomOut,
      BrowserCommand.ZoomReset,
    ]);
  });

  it("asks the browser for picture-in-picture", async () => {
    const ran = await new Promise<string>((resolve) => {
      choosePageCommand(
        { command: PageMenuCommand.PictureInPicture },
        plain({ run: resolve }),
        { browse: () => undefined, openWindow: () => undefined },
      );
    });
    expect(ran).toBe("picture-in-picture");
  });

  it("puts the chosen suggestion in place of the misspelled word", async () => {
    const replaced = await new Promise<string>((resolve) => {
      choosePageCommand(
        { command: PageMenuCommand.ReplaceMisspelling, replacement: "receive" },
        plain({ replaceMisspelling: resolve }),
        { browse: () => undefined, openWindow: () => undefined },
      );
    });
    expect(replaced).toBe("receive");
  });

  it("asks the browser to add the misspelled word to the dictionary", async () => {
    const ran = await new Promise<string>((resolve) => {
      choosePageCommand(
        { command: PageMenuCommand.AddToDictionary },
        plain({ run: resolve }),
        { browse: () => undefined, openWindow: () => undefined },
      );
    });
    expect(ran).toBe("add-to-dictionary");
  });
});
