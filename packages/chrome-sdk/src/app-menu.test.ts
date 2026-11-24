import { describe, expect, it } from "bun:test";

import type { KeyLike } from "./app-menu";
import {
  acceleratedBy,
  acceleratorOf,
  appMenu,
  appPopupMenu,
  MenuEntryKind,
  openedByMnemonic,
  pressesAccelerator,
  ToggleKind,
} from "./app-menu";

const written = (entries: object[]) => JSON.stringify(entries);

const entry = (fields: object) => ({
  checked: false,
  enabled: true,
  label: "",
  type: "normal",
  visible: true,
  ...fields,
});

const keys = (fields: Partial<KeyLike>): KeyLike => ({
  altKey: false,
  code: "",
  ctrlKey: false,
  key: "",
  metaKey: false,
  shiftKey: false,
  ...fields,
});

const FILE = written([
  entry({
    id: 1,
    label: "&File",
    submenu: [
      entry({ accelerator: "CmdOrCtrl+N", id: 2, label: "&New Window" }),
      entry({ id: 3, type: "separator" }),
      entry({ accelerator: "Ctrl+Q", enabled: false, id: 4, label: "Quit" }),
      entry({ id: 5, label: "Hidden", visible: false }),
    ],
    type: "submenu",
  }),
  entry({
    id: 6,
    label: "&View",
    submenu: [
      entry({ checked: true, id: 7, label: "Sidebar", type: "checkbox" }),
      entry({ id: 8, label: "Light", type: "radio" }),
    ],
    type: "submenu",
  }),
]);

describe(appPopupMenu, () => {
  it("reads the entries and where the menu goes", () => {
    const popup = JSON.stringify({
      menu: [
        entry({ id: 2, label: "Settings" }),
        entry({ id: 3, label: "Hidden", visible: false }),
      ],
      x: 12,
      y: 34,
    });

    expect(appPopupMenu(popup)).toEqual({
      at: { x: 12, y: 34 },
      entries: appMenu(written([entry({ id: 2, label: "Settings" })])),
    });
  });

  it("throws for a popup menu the engine should have refused", () => {
    expect(() =>
      appPopupMenu(JSON.stringify({ menu: [entry({ id: 2 })], x: 1 })),
    ).toThrow("the engine listed a popup menu it should have refused");
  });
});

describe(appMenu, () => {
  it("reads the entries, leaving hidden ones out", () => {
    expect(appMenu(FILE)).toEqual([
      {
        accelerator: undefined,
        enabled: true,
        icon: undefined,
        id: 1,
        kind: MenuEntryKind.Item,
        label: "File",
        mnemonic: 0,
        submenu: [
          {
            accelerator: {
              alt: false,
              ctrl: true,
              key: "N",
              label: "Ctrl+N",
              meta: false,
              shift: false,
            },
            enabled: true,
            icon: undefined,
            id: 2,
            kind: MenuEntryKind.Item,
            label: "New Window",
            mnemonic: 0,
            submenu: undefined,
            toggle: undefined,
          },
          { id: 3, kind: MenuEntryKind.Separator },
          {
            accelerator: {
              alt: false,
              ctrl: true,
              key: "Q",
              label: "Ctrl+Q",
              meta: false,
              shift: false,
            },
            enabled: false,
            icon: undefined,
            id: 4,
            kind: MenuEntryKind.Item,
            label: "Quit",
            mnemonic: undefined,
            submenu: undefined,
            toggle: undefined,
          },
        ],
        toggle: undefined,
      },
      {
        accelerator: undefined,
        enabled: true,
        icon: undefined,
        id: 6,
        kind: MenuEntryKind.Item,
        label: "View",
        mnemonic: 0,
        submenu: [
          expect.objectContaining({
            id: 7,
            toggle: { checked: true, kind: ToggleKind.Checkmark },
          }),
          expect.objectContaining({
            id: 8,
            toggle: { checked: false, kind: ToggleKind.Radio },
          }),
        ],
        toggle: undefined,
      },
    ]);
  });

  it("reads && as an ampersand and the first lone & as the mnemonic", () => {
    const [item] = appMenu(
      written([entry({ id: 1, label: "Find && Rep&lace" })]),
    );

    expect(item).toMatchObject({ label: "Find & Replace", mnemonic: 10 });
  });

  it("throws for a menu the engine should have refused", () => {
    expect(() => appMenu(written([{ id: 0 }]))).toThrow(
      "the engine listed a menu bar it should have refused",
    );
  });
});

describe(acceleratorOf, () => {
  it("names the modifiers as a Linux menu shows them, in order", () => {
    expect(acceleratorOf("Shift+CommandOrControl+Alt+Super+F5")).toEqual({
      alt: true,
      ctrl: true,
      key: "F5",
      label: "Ctrl+Alt+Shift+Super+F5",
      meta: true,
      shift: true,
    });
  });

  it("reads Electron's key names and the plus key", () => {
    expect(acceleratorOf("Ctrl+Plus")?.key).toBe("=");
    expect(acceleratorOf("Ctrl++")?.key).toBe("=");
    expect(acceleratorOf("Alt+Up")).toMatchObject({
      key: "ArrowUp",
      label: "Alt+Up",
    });
    expect(acceleratorOf("CmdOrCtrl+,")).toMatchObject({
      key: ",",
      label: "Ctrl+,",
    });
    expect(acceleratorOf("Ctrl+Space")?.label).toBe("Ctrl+Space");
  });

  it("is none for a key it can't match", () => {
    expect(acceleratorOf("Ctrl+MediaPlayPause")).toBeUndefined();
    expect(acceleratorOf("Ctrl+A+B")).toBeUndefined();
    expect(acceleratorOf("Ctrl")).toBeUndefined();
  });
});

describe(pressesAccelerator, () => {
  const newWindow = acceleratorOf("CmdOrCtrl+Shift+N");

  it("matches the key by where it is, so Shift doesn't change it", () => {
    expect(
      newWindow !== undefined &&
        pressesAccelerator(
          newWindow,
          keys({ code: "KeyN", ctrlKey: true, key: "N", shiftKey: true }),
        ),
    ).toBe(true);
  });

  it("needs exactly its modifiers", () => {
    expect(
      newWindow !== undefined &&
        pressesAccelerator(
          newWindow,
          keys({ code: "KeyN", ctrlKey: true, key: "n" }),
        ),
    ).toBe(false);
  });
});

describe(acceleratedBy, () => {
  it("finds the enabled entry whose keys were pressed, in any submenu", () => {
    const menu = appMenu(FILE);

    expect(
      acceleratedBy(menu, keys({ code: "KeyN", ctrlKey: true, key: "n" }))?.id,
    ).toBe(2);
    expect(
      acceleratedBy(menu, keys({ code: "KeyQ", ctrlKey: true, key: "q" })),
    ).toBeUndefined();
  });
});

describe(openedByMnemonic, () => {
  it("finds the top-level entry Alt and its letter open", () => {
    const menu = appMenu(FILE);

    expect(
      openedByMnemonic(menu, keys({ altKey: true, code: "KeyV", key: "v" }))
        ?.id,
    ).toBe(6);
    expect(
      openedByMnemonic(
        menu,
        keys({ altKey: true, code: "KeyV", ctrlKey: true, key: "v" }),
      ),
    ).toBeUndefined();
    expect(
      openedByMnemonic(menu, keys({ altKey: true, code: "KeyZ", key: "z" })),
    ).toBeUndefined();
  });
});
