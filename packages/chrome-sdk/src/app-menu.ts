// An Electron app window's menu bar: the menu the engine lists on the window
// as JSON (`DomicileBrowserWindow.menu`), read into entries a shell draws, and
// the app's accelerators matched against the keys a browser window hands
// back. See "Menu bars" in docs/SHELL-BROWSER-WINDOWS.md.

import { z } from "zod";
import type { Toggle } from "./dbusmenu";
import { MenuEntryKind, ToggleKind } from "./dbusmenu";

export { MenuEntryKind, ToggleKind } from "./dbusmenu";

/** The keys that run an entry, as Electron's accelerators name them. */
export type Accelerator = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The Super key, which Electron also calls Meta. */
  meta: boolean;
  /**
   * The key, by where it is on a US keyboard as Chromium's accelerators go:
   * an uppercase letter, a digit, the character a punctuation key types
   * unshifted, or a `KeyboardEvent.key` name such as `ArrowUp` or `F5`.
   */
  key: string;
  /** How a menu shows it, such as `Ctrl+Shift+N`. */
  label: string;
};

/** One thing the menu can do, or a submenu. */
export type AppMenuItem = {
  /** What `browser.clickMenu` names it by. */
  id: number;
  /** Its text, with the mnemonic's `&` removed. */
  label: string;
  /** Where in `label` the access key is, if an `&` marked one. */
  mnemonic: number | undefined;
  enabled: boolean;
  /** The app's picture for it, as a PNG `data:` URL. */
  icon: string | undefined;
  toggle: Toggle | undefined;
  accelerator: Accelerator | undefined;
  /** Its entries, for an item that opens a submenu. */
  submenu: readonly AppMenuEntry[] | undefined;
};

export type AppMenuEntry =
  | (AppMenuItem & { kind: MenuEntryKind.Item })
  | { id: number; kind: MenuEntryKind.Separator };

type Written = {
  id: number;
  type: "normal" | "separator" | "submenu" | "checkbox" | "radio";
  label: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accelerator?: string | undefined;
  icon?: string | undefined;
  submenu?: Written[] | undefined;
};

const writtenSchema: z.ZodType<Written> = z.lazy(() =>
  z.object({
    accelerator: z.string().optional(),
    checked: z.boolean(),
    enabled: z.boolean(),
    icon: z.string().optional(),
    id: z.number().int().min(1),
    label: z.string(),
    submenu: z.array(writtenSchema).optional(),
    type: z.enum(["normal", "separator", "submenu", "checkbox", "radio"]),
    visible: z.boolean(),
  }),
);

/**
 * The entries of `menu`, a browser window's `menu`, with hidden ones left
 * out. Throws for a menu the engine should not have listed: it checks each
 * one the app sends.
 */
export const appMenu = (menu: string): readonly AppMenuEntry[] => {
  const parsed = z.array(writtenSchema).safeParse(JSON.parse(menu));
  if (parsed.success) {
    return entriesOf(parsed.data);
  } else {
    throw new Error(
      `the engine listed a menu bar it should have refused: ${parsed.error.message}`,
    );
  }
};

/** An Electron app's popup menu over its window, and where it goes. */
export type AppPopupMenu = {
  entries: readonly AppMenuEntry[];
  /** Where it goes, in CSS pixels from the window's page's top left. */
  at: { x: number; y: number };
};

/**
 * A window's `popupMenu`, as the engine lists it: `{menu, x, y}`. Throws for
 * one the engine should have refused.
 */
export const appPopupMenu = (popup: string): AppPopupMenu => {
  const parsed = z
    .object({ menu: z.array(writtenSchema), x: z.number(), y: z.number() })
    .safeParse(JSON.parse(popup));
  if (parsed.success) {
    return {
      at: { x: parsed.data.x, y: parsed.data.y },
      entries: entriesOf(parsed.data.menu),
    };
  } else {
    throw new Error(
      `the engine listed a popup menu it should have refused: ${parsed.error.message}`,
    );
  }
};

const entriesOf = (written: readonly Written[]): AppMenuEntry[] =>
  written
    .filter(({ visible }) => visible)
    .map((entry) =>
      entry.type === "separator"
        ? { id: entry.id, kind: MenuEntryKind.Separator }
        : { ...itemOf(entry), kind: MenuEntryKind.Item },
    );

const itemOf = (entry: Written): AppMenuItem => ({
  accelerator:
    entry.accelerator === undefined
      ? undefined
      : acceleratorOf(entry.accelerator),
  enabled: entry.enabled,
  icon: entry.icon,
  id: entry.id,
  ...withoutMnemonic(entry.label),
  submenu:
    entry.type === "submenu" || entry.submenu !== undefined
      ? entriesOf(entry.submenu ?? [])
      : undefined,
  toggle: toggleOf(entry),
});

const toggleOf = ({ checked, type }: Written): Toggle | undefined => {
  switch (type) {
    case "checkbox": {
      return { checked, kind: ToggleKind.Checkmark };
    }
    case "radio": {
      return { checked, kind: ToggleKind.Radio };
    }
    case "normal":
    case "separator":
    case "submenu": {
      return undefined;
    }
  }
};

/** An `&`, and the one after it if any. */
const AMPERSAND = /&(&?)/g;

/**
 * `written` without Electron's mnemonic marker: the first `&` that is not
 * half of a `&&` marks the next character, and each `&&` is an `&`.
 */
const withoutMnemonic = (
  written: string,
): { label: string; mnemonic: number | undefined } => {
  const unescaped = (text: string) => text.replaceAll(AMPERSAND, "$1");
  const label = unescaped(written);
  const marker = [...written.matchAll(AMPERSAND)].find(
    ([, doubled]) => doubled === "",
  );
  const at =
    marker === undefined
      ? undefined
      : unescaped(written.slice(0, marker.index)).length;
  return {
    label,
    mnemonic: at === undefined || at === label.length ? undefined : at,
  };
};

/** Electron's modifier names, in any case, and what each one holds down. */
const MODIFIERS: Readonly<
  Record<string, "ctrl" | "alt" | "shift" | "meta" | undefined>
> = {
  alt: "alt",
  altgr: "alt",
  cmd: "meta",
  cmdorctrl: "ctrl",
  command: "meta",
  commandorcontrol: "ctrl",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  option: "alt",
  shift: "shift",
  super: "meta",
};

/** Electron's key names, in lowercase, as `Accelerator.key` has them. */
const KEYS: Readonly<Record<string, string | undefined>> = {
  backspace: "Backspace",
  delete: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  left: "ArrowLeft",
  pagedown: "PageDown",
  pageup: "PageUp",
  // Chromium's VKEY_OEM_PLUS: the `=` key, as Electron's Ctrl+Plus zooms.
  plus: "=",
  return: "Enter",
  right: "ArrowRight",
  space: " ",
  tab: "Tab",
  up: "ArrowUp",
};

/** How a menu shows each modifier, in the order it shows them. */
const SHOWN: readonly [keyof Omit<Accelerator, "key" | "label">, string][] = [
  ["ctrl", "Ctrl"],
  ["alt", "Alt"],
  ["shift", "Shift"],
  ["meta", "Super"],
];

/**
 * `written`, an Electron accelerator such as `CmdOrCtrl+Shift+N`, or none
 * when it names a key this can't match: the app's own accelerator, which the
 * menu then shows no keys for.
 */
export const acceleratorOf = (written: string): Accelerator | undefined => {
  // `+` names the plus key as well as joining the parts: `Ctrl++`.
  const parts = written.endsWith("++")
    ? [...written.slice(0, -2).split("+"), "Plus"]
    : written.split("+");
  const accelerator = { alt: false, ctrl: false, meta: false, shift: false };
  let key: string | undefined;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier !== undefined) {
      accelerator[modifier] = true;
    } else if (key === undefined) {
      key = keyOf(part);
      if (key === undefined) {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  if (key === undefined) {
    return undefined;
  }
  const shownKey = key === " " ? "Space" : key.replace(/^Arrow/, "");
  return {
    ...accelerator,
    key,
    label: [
      ...SHOWN.filter(([held]) => accelerator[held]).map(([, name]) => name),
      shownKey,
    ].join("+"),
  };
};

const keyOf = (part: string): string | undefined => {
  if (/^[a-z0-9]$/i.test(part) || /^[-=[\]\\;',./`]$/.test(part)) {
    return part.toUpperCase();
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) {
    return part.toUpperCase();
  } else {
    return KEYS[part.toLowerCase()];
  }
};

/** `KeyboardEvent.code`s that name a key by the character it types unshifted. */
const PUNCTUATION: Readonly<Record<string, string | undefined>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: " ",
};

/** The key an event pressed, as `Accelerator.key` names it. */
const pressedKey = ({ code, key }: KeyLike): string => {
  const letterOrDigit = /^(?:Key|Digit)(.)$/.exec(code)?.[1];
  return letterOrDigit ?? PUNCTUATION[code] ?? key;
};

/** What of a `KeyboardEvent` an accelerator is matched against. */
export type KeyLike = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/** Whether `event` presses `accelerator`'s keys, and no other modifiers. */
export const pressesAccelerator = (
  accelerator: Accelerator,
  event: KeyLike,
): boolean =>
  accelerator.ctrl === event.ctrlKey &&
  accelerator.alt === event.altKey &&
  accelerator.shift === event.shiftKey &&
  accelerator.meta === event.metaKey &&
  accelerator.key === pressedKey(event);

/**
 * The enabled entry in `entries`, or in the submenus of enabled ones, whose
 * accelerator `event` presses: what Electron runs for it.
 */
export const acceleratedBy = (
  entries: readonly AppMenuEntry[],
  event: KeyLike,
): AppMenuItem | undefined => {
  for (const entry of entries) {
    if (entry.kind === MenuEntryKind.Item && entry.enabled) {
      if (
        entry.accelerator !== undefined &&
        entry.submenu === undefined &&
        pressesAccelerator(entry.accelerator, event)
      ) {
        return entry;
      }
      const inside =
        entry.submenu === undefined
          ? undefined
          : acceleratedBy(entry.submenu, event);
      if (inside !== undefined) {
        return inside;
      }
    }
  }
  return undefined;
};

/**
 * The top-level entry whose mnemonic `event` presses with Alt alone, as Alt+F
 * opens a File menu.
 */
export const openedByMnemonic = (
  entries: readonly AppMenuEntry[],
  event: KeyLike,
): AppMenuItem | undefined => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return undefined;
  }
  const pressed = pressedKey(event);
  return entries.find(
    (entry): entry is AppMenuItem & { kind: MenuEntryKind.Item } =>
      entry.kind === MenuEntryKind.Item &&
      entry.enabled &&
      entry.mnemonic !== undefined &&
      entry.label.charAt(entry.mnemonic).toUpperCase() === pressed,
  );
};
