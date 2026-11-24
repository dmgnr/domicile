// Builds a browser window's context menu from `WEBVIEW_CONTEXT_MENU_EVENT`,
// with Chrome's items for what was under the click. Browser-side actions (copy
// an image, save a link) go back through the event; the rest (back, open in a
// new window, search) are the window's own.

import { searchUrl } from "@domicile-desktop/manganese-address/search";
import type { WebViewContextMenuAction } from "@domicile-desktop/sdk/webview-element";
import { WEBVIEW_MEDIA_TYPES } from "@domicile-desktop/sdk/webview-element";
import { z } from "zod";
import { BrowserCommand } from "./browser-command";
import { isFullyZoomedIn, isFullyZoomedOut, isUnzoomed } from "./zoom-steps";

/** What kind of thing was under the click. */
export enum MediaKind {
  None,
  Image,
  Video,
  Audio,
  Canvas,
  /** A file input or a plugin: nothing this menu has a command for. */
  Other,
}

/** Everything the menu can do. */
export enum PageMenuCommand {
  Back = "Back",
  Forward = "Forward",
  Reload = "Reload",
  ZoomIn = "ZoomIn",
  ZoomOut = "ZoomOut",
  ZoomReset = "ZoomReset",
  OpenLink = "OpenLink",
  SaveLinkAs = "SaveLinkAs",
  CopyLinkAddress = "CopyLinkAddress",
  OpenMedia = "OpenMedia",
  SaveMediaAs = "SaveMediaAs",
  PictureInPicture = "PictureInPicture",
  CopyImage = "CopyImage",
  CopyMediaAddress = "CopyMediaAddress",
  ReplaceMisspelling = "ReplaceMisspelling",
  /** Shown, grayed out, when a misspelled word has nothing to become. */
  NoSpellingSuggestions = "NoSpellingSuggestions",
  AddToDictionary = "AddToDictionary",
  Undo = "Undo",
  Redo = "Redo",
  Cut = "Cut",
  Copy = "Copy",
  Paste = "Paste",
  PasteAsPlainText = "PasteAsPlainText",
  Delete = "Delete",
  SelectAll = "SelectAll",
  Search = "Search",
  Inspect = "Inspect",
}

/** A right click in a page, as this shell reads the engine's event. */
export type PageContext = {
  /** What the page says can be done where the click was. */
  can: {
    copy: boolean;
    cut: boolean;
    delete: boolean;
    paste: boolean;
    redo: boolean;
    selectAll: boolean;
    undo: boolean;
  };
  editable: boolean;
  /** Whether an image under the click has pixels to copy. */
  hasPixels: boolean;
  link: string | undefined;
  media: MediaKind;
  /** The misspelled word under the click, and what it could be instead. */
  misspelling: { suggestions: readonly string[]; word: string } | undefined;
  /** Whether a video can go into picture-in-picture, and whether it is in it. */
  pictureInPicture: { active: boolean; can: boolean };
  /** Put `word` in place of the misspelled word under the click. */
  replaceMisspelling: (word: string) => void;
  /** Ask the browser to do one of the things only it can, for this click. */
  run: (action: WebViewContextMenuAction) => void;
  selection: string;
  /** The address of the image, video or audio under the click. */
  source: string | undefined;
  /** Where the click was, in CSS pixels from the view's top left. */
  x: number;
  y: number;
};

/** One line of the menu. */
export type PageMenuItem = {
  command: PageMenuCommand;
  disabled: boolean;
  label: string;
  /** For a spelling suggestion: the word it puts in place. */
  replacement?: string | undefined;
  shortcut?: string | undefined;
};

/** The longest a selection is quoted in a label before it is cut short. */
const QUOTED_LENGTH = 40;

/**
 * The engine's word for what was under the click, mapped to this shell's.
 * Throws on one it cannot name, which an engine newer than this shell can
 * send.
 */
const mediaSchema = z.enum(WEBVIEW_MEDIA_TYPES).transform((media) => {
  switch (media) {
    case "none": {
      return MediaKind.None;
    }
    case "image": {
      return MediaKind.Image;
    }
    case "video": {
      return MediaKind.Video;
    }
    case "audio": {
      return MediaKind.Audio;
    }
    case "canvas": {
      return MediaKind.Canvas;
    }
    case "file":
    case "plugin": {
      return MediaKind.Other;
    }
  }
});

/** The engine's event, read once at the boundary. */
export const pageContextOf = (
  event: DomicileContextMenuEvent,
): PageContext => ({
  can: {
    copy: event.canCopy,
    cut: event.canCut,
    delete: event.canDelete,
    paste: event.canPaste,
    redo: event.canRedo,
    selectAll: event.canSelectAll,
    undo: event.canUndo,
  },
  editable: event.isEditable,
  hasPixels: event.hasImageContents,
  link: addressOf(event.linkUrl),
  media: mediaSchema.parse(event.mediaType),
  misspelling:
    event.misspelledWord === ""
      ? undefined
      : {
          suggestions: event.spellingSuggestions,
          word: event.misspelledWord,
        },
  pictureInPicture: {
    active: event.inPictureInPicture,
    can: event.canPictureInPicture,
  },
  replaceMisspelling: (word) => {
    event.replaceMisspelling(word);
  },
  run: (action) => {
    event.run(action);
  },
  selection: event.selectionText,
  source: addressOf(event.srcUrl),
  x: event.x,
  y: event.y,
});

/**
 * The menu for `context`, in groups a line goes between: what is under the
 * click — a link, an image, a field, a selection — or the page's history and
 * zoom when there is nothing, and DevTools last, always.
 */
export const pageMenuFor = (
  context: PageContext,
  page: { canGoBack: boolean; canGoForward: boolean; zoom: number },
): PageMenuItem[][] => {
  const groups = [
    ...(context.link === undefined ? [] : [linkGroup()]),
    ...mediaGroups(context),
    ...(context.editable ? editGroups(context) : selectionGroups(context)),
  ];
  return [
    ...(groups.length === 0
      ? [historyGroup(page), zoomGroup(page.zoom)]
      : groups),
    [
      {
        command: PageMenuCommand.Inspect,
        disabled: false,
        label: "Inspect",
        shortcut: "Ctrl+Shift+I",
      },
    ],
  ];
};

/** What a window does that the browser does not. */
export type PageMenuWindow = {
  /** Run one of the window's own commands: its history, its reload. */
  browse: (command: BrowserCommand) => void;
  /** Ask the desktop for a second browser window at `url`. */
  openWindow: (url: string) => void;
};

/**
 * Carry out `command`, chosen from the menu for `context`: on the window, or
 * handed back to the browser through the event the menu came from.
 */
export const choosePageCommand = (
  { command, replacement }: Pick<PageMenuItem, "command" | "replacement">,
  context: PageContext,
  window: PageMenuWindow,
): void => {
  switch (command) {
    case PageMenuCommand.ReplaceMisspelling: {
      context.replaceMisspelling(required(replacement, "replacement"));
      break;
    }
    case PageMenuCommand.NoSpellingSuggestions: {
      throw new Error("page menu: chose the grayed-out no-suggestions line");
    }
    case PageMenuCommand.Back: {
      window.browse(BrowserCommand.Back);
      break;
    }
    case PageMenuCommand.Forward: {
      window.browse(BrowserCommand.Forward);
      break;
    }
    case PageMenuCommand.Reload: {
      window.browse(BrowserCommand.Reload);
      break;
    }
    case PageMenuCommand.ZoomIn: {
      window.browse(BrowserCommand.ZoomIn);
      break;
    }
    case PageMenuCommand.ZoomOut: {
      window.browse(BrowserCommand.ZoomOut);
      break;
    }
    case PageMenuCommand.ZoomReset: {
      window.browse(BrowserCommand.ZoomReset);
      break;
    }
    case PageMenuCommand.OpenLink: {
      window.openWindow(required(context.link, "link"));
      break;
    }
    case PageMenuCommand.OpenMedia: {
      window.openWindow(required(context.source, "source"));
      break;
    }
    case PageMenuCommand.Search: {
      window.openWindow(searchUrl(context.selection));
      break;
    }
    case PageMenuCommand.SaveLinkAs:
    case PageMenuCommand.CopyLinkAddress:
    case PageMenuCommand.SaveMediaAs:
    case PageMenuCommand.PictureInPicture:
    case PageMenuCommand.CopyImage:
    case PageMenuCommand.CopyMediaAddress:
    case PageMenuCommand.AddToDictionary:
    case PageMenuCommand.Undo:
    case PageMenuCommand.Redo:
    case PageMenuCommand.Cut:
    case PageMenuCommand.Copy:
    case PageMenuCommand.Paste:
    case PageMenuCommand.PasteAsPlainText:
    case PageMenuCommand.Delete:
    case PageMenuCommand.SelectAll:
    case PageMenuCommand.Inspect: {
      context.run(browserActionFor(command));
      break;
    }
  }
};

/** The browser's word for a command only it can carry out. */
const browserActionFor = (
  command:
    | PageMenuCommand.SaveLinkAs
    | PageMenuCommand.CopyLinkAddress
    | PageMenuCommand.SaveMediaAs
    | PageMenuCommand.PictureInPicture
    | PageMenuCommand.CopyImage
    | PageMenuCommand.CopyMediaAddress
    | PageMenuCommand.AddToDictionary
    | PageMenuCommand.Undo
    | PageMenuCommand.Redo
    | PageMenuCommand.Cut
    | PageMenuCommand.Copy
    | PageMenuCommand.Paste
    | PageMenuCommand.PasteAsPlainText
    | PageMenuCommand.Delete
    | PageMenuCommand.SelectAll
    | PageMenuCommand.Inspect,
): WebViewContextMenuAction => {
  switch (command) {
    case PageMenuCommand.SaveLinkAs: {
      return "save-link-as";
    }
    case PageMenuCommand.CopyLinkAddress: {
      return "copy-link-address";
    }
    case PageMenuCommand.SaveMediaAs: {
      return "save-media-as";
    }
    case PageMenuCommand.PictureInPicture: {
      return "picture-in-picture";
    }
    case PageMenuCommand.CopyImage: {
      return "copy-image";
    }
    case PageMenuCommand.CopyMediaAddress: {
      return "copy-media-address";
    }
    case PageMenuCommand.AddToDictionary: {
      return "add-to-dictionary";
    }
    case PageMenuCommand.Undo: {
      return "undo";
    }
    case PageMenuCommand.Redo: {
      return "redo";
    }
    case PageMenuCommand.Cut: {
      return "cut";
    }
    case PageMenuCommand.Copy: {
      return "copy";
    }
    case PageMenuCommand.Paste: {
      return "paste";
    }
    case PageMenuCommand.PasteAsPlainText: {
      return "paste-and-match-style";
    }
    case PageMenuCommand.Delete: {
      return "delete";
    }
    case PageMenuCommand.SelectAll: {
      return "select-all";
    }
    case PageMenuCommand.Inspect: {
      return "inspect";
    }
  }
};

/** What the menu offered a command for, which it therefore has. */
const required = (value: string | undefined, what: string): string => {
  if (value === undefined) {
    throw new Error(`page menu: a command for a ${what} with none to use`);
  } else {
    return value;
  }
};

/** `""` is the engine's none. */
const addressOf = (address: string): string | undefined =>
  address === "" ? undefined : address;

const item = (
  command: PageMenuCommand,
  label: string,
  disabled = false,
  shortcut?: string,
): PageMenuItem => ({ command, disabled, label, shortcut });

const historyGroup = (history: {
  canGoBack: boolean;
  canGoForward: boolean;
}): PageMenuItem[] => [
  item(PageMenuCommand.Back, "Back", !history.canGoBack, "Alt+←"),
  item(PageMenuCommand.Forward, "Forward", !history.canGoForward, "Alt+→"),
  item(PageMenuCommand.Reload, "Reload", false, "Ctrl+R"),
];

/**
 * The page's zoom: a step each way, as Ctrl+plus and Ctrl+minus, and back to
 * normal once zoomed, as Ctrl+0.
 */
const zoomGroup = (zoom: number): PageMenuItem[] => [
  item(PageMenuCommand.ZoomIn, "Zoom in", isFullyZoomedIn(zoom), "Ctrl++"),
  item(PageMenuCommand.ZoomOut, "Zoom out", isFullyZoomedOut(zoom), "Ctrl+−"),
  ...(isUnzoomed(zoom)
    ? []
    : [item(PageMenuCommand.ZoomReset, "Reset zoom", false, "Ctrl+0")]),
];

const linkGroup = (): PageMenuItem[] => [
  item(PageMenuCommand.OpenLink, "Open link in new window"),
  item(PageMenuCommand.SaveLinkAs, "Save link as…"),
  item(PageMenuCommand.CopyLinkAddress, "Copy link address"),
];

/**
 * An image's, a video's or an audio's commands, named for which it is. A
 * canvas has pixels and no address; a broken image an address and no pixels.
 * A video can go into picture-in-picture, or come out.
 */
const mediaGroups = (context: PageContext): PageMenuItem[][] => {
  const noun = nounOf(context.media);
  if (noun === undefined) {
    return [];
  } else {
    const copiesPixels =
      context.hasPixels &&
      (context.media === MediaKind.Image || context.media === MediaKind.Canvas);
    const group = [
      ...(context.source === undefined
        ? []
        : [item(PageMenuCommand.OpenMedia, `Open ${noun} in new window`)]),
      ...(context.source === undefined && !copiesPixels
        ? []
        : [item(PageMenuCommand.SaveMediaAs, `Save ${noun} as…`)]),
      ...(copiesPixels ? [item(PageMenuCommand.CopyImage, "Copy image")] : []),
      ...(context.source === undefined
        ? []
        : [item(PageMenuCommand.CopyMediaAddress, `Copy ${noun} address`)]),
      ...(context.pictureInPicture.can
        ? [
            item(
              PageMenuCommand.PictureInPicture,
              context.pictureInPicture.active
                ? "Exit picture in picture"
                : "Picture in picture",
            ),
          ]
        : []),
    ];
    return group.length === 0 ? [] : [group];
  }
};

const nounOf = (media: MediaKind): string | undefined => {
  switch (media) {
    case MediaKind.Image:
    case MediaKind.Canvas: {
      return "image";
    }
    case MediaKind.Video: {
      return "video";
    }
    case MediaKind.Audio: {
      return "audio";
    }
    case MediaKind.None:
    case MediaKind.Other: {
      return undefined;
    }
  }
};

/**
 * A field's, as Chrome's: a misspelled word's fixes, history, then the
 * clipboard and the selection.
 */
const editGroups = (context: PageContext): PageMenuItem[][] => [
  ...(context.misspelling === undefined
    ? []
    : [spellingGroup(context.misspelling.suggestions)]),
  [
    item(PageMenuCommand.Undo, "Undo", !context.can.undo),
    item(PageMenuCommand.Redo, "Redo", !context.can.redo),
  ],
  [
    item(PageMenuCommand.Cut, "Cut", !context.can.cut),
    item(PageMenuCommand.Copy, "Copy", !context.can.copy),
    item(PageMenuCommand.Paste, "Paste", !context.can.paste),
    item(
      PageMenuCommand.PasteAsPlainText,
      "Paste as plain text",
      !context.can.paste,
    ),
    item(PageMenuCommand.Delete, "Delete", !context.can.delete),
    item(PageMenuCommand.SelectAll, "Select all", !context.can.selectAll),
  ],
];

/** What a misspelled word could be instead, or that it is right after all. */
const spellingGroup = (suggestions: readonly string[]): PageMenuItem[] => [
  ...(suggestions.length === 0
    ? [
        item(
          PageMenuCommand.NoSpellingSuggestions,
          "No spelling suggestions",
          true,
        ),
      ]
    : suggestions.map((word) => ({
        ...item(PageMenuCommand.ReplaceMisspelling, word),
        replacement: word,
      }))),
  item(PageMenuCommand.AddToDictionary, "Add to dictionary"),
];

/** Text selected outside a field: copy it, or search for it. */
const selectionGroups = (context: PageContext): PageMenuItem[][] =>
  context.selection === ""
    ? []
    : [
        [
          item(PageMenuCommand.Copy, "Copy"),
          item(
            PageMenuCommand.Search,
            `Search for “${quoted(context.selection)}”`,
          ),
        ],
      ];

const quoted = (selection: string): string => {
  const line = selection.replaceAll(/\s+/gu, " ").trim();
  return line.length > QUOTED_LENGTH
    ? `${line.slice(0, QUOTED_LENGTH)}…`
    : line;
};
