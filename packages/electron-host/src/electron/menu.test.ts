import { describe, expect, it } from "bun:test";

import { createMenu } from "./menu";
import { nativeImage } from "./native-image";

/** A menu module whose roles record what they did, with no window focused. */
const setUp = () => {
  const did: string[] = [];
  const shown: unknown[] = [];
  const { Menu, MenuItem, model, click } = createMenu({
    appName: () => "Notes",
    focusedWindow: () => null,
    popup: () => {
      throw new Error("these menus pop up over nothing");
    },
    roles: {
      copy: () => did.push("copy"),
      quit: () => did.push("quit"),
    },
    setApplicationMenu: (menu) => shown.push(menu),
  });
  return { click, did, Menu, MenuItem, model, shown };
};

describe("Menu.buildFromTemplate", () => {
  it("builds items with their labels, kinds, states and submenus", () => {
    const { Menu, model } = setUp();
    const menu = Menu.buildFromTemplate([
      { accelerator: "CmdOrCtrl+N", id: "new", label: "New Note" },
      { type: "separator" },
      { checked: true, label: "Pin", type: "checkbox" },
      { enabled: false, label: "Share" },
      { label: "Hidden", visible: false },
      { label: "Recent", submenu: [{ label: "Groceries" }] },
    ]);

    expect(menu.items.map((item) => item.type)).toEqual([
      "normal",
      "separator",
      "checkbox",
      "normal",
      "normal",
      "submenu",
    ]);
    expect(menu.getMenuItemById("new")?.label).toBe("New Note");
    const [entry, separator, pin, share, hidden, recent] = model(menu);
    expect(entry).toMatchObject({
      accelerator: "CmdOrCtrl+N",
      checked: false,
      enabled: true,
      label: "New Note",
      type: "normal",
      visible: true,
    });
    expect(separator).toMatchObject({ type: "separator" });
    expect(pin).toMatchObject({ checked: true, type: "checkbox" });
    expect(share).toMatchObject({ enabled: false });
    expect(hidden).toMatchObject({ visible: false });
    expect(recent?.submenu?.map(({ label }) => label)).toEqual(["Groceries"]);
    // Each entry has its own number, for a click to name it.
    const ids = model(menu).map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives a role its label and accelerator, and expands a role's menu", () => {
    const { Menu, model } = setUp();
    const menu = Menu.buildFromTemplate([
      { role: "editMenu" },
      { role: "quit" },
      { label: "Leave", role: "quit" },
    ]);

    const [edit, quit, leave] = model(menu);
    expect(edit?.label).toBe("Edit");
    expect(edit?.submenu?.map(({ label, type }) => label || type)).toEqual([
      "Undo",
      "Redo",
      "separator",
      "Cut",
      "Copy",
      "Paste",
      "Delete",
      "separator",
      "Select All",
    ]);
    expect(quit).toMatchObject({
      accelerator: "CommandOrControl+Q",
      label: "Quit",
    });
    expect(leave?.label).toBe("Leave");
  });

  it("names the app in about, and hides roles only macOS has", () => {
    const { Menu, model } = setUp();

    const [about, services] = model(
      Menu.buildFromTemplate([{ role: "about" }, { role: "services" }]),
    );

    expect(about?.label).toBe("About Notes");
    expect(services?.visible).toBe(false);
  });

  it("refuses a role Electron has not", () => {
    const { Menu } = setUp();

    expect(() =>
      Menu.buildFromTemplate([{ role: "launchRockets" as never }]),
    ).toThrow('"launchRockets" is not a menu item role');
  });

  it("puts an item before or after the one it names", () => {
    const { Menu } = setUp();

    const menu = Menu.buildFromTemplate([
      { id: "a", label: "A" },
      { id: "c", label: "C" },
      { after: ["a"], id: "b", label: "B" },
      { before: ["a"], id: "first", label: "First" },
    ]);

    expect(menu.items.map(({ label }) => label)).toEqual([
      "First",
      "A",
      "B",
      "C",
    ]);
  });

  it("carries an icon as a PNG data: URL", () => {
    const { Menu, model } = setUp();
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    );

    const [entry] = model(Menu.buildFromTemplate([{ icon, label: "Pic" }]));

    expect(entry?.icon).toStartWith("data:image/png;base64,iVBOR");
  });
});

describe("a click", () => {
  it("reaches the item's click with the item", () => {
    const { click, Menu, model } = setUp();
    const heard: unknown[] = [];
    const menu = Menu.buildFromTemplate([
      {
        click: (item, window) => heard.push(item.label, window),
        label: "Open",
      },
    ]);

    click(menu, model(menu)[0]?.id ?? 0);

    expect(heard).toEqual(["Open", null]);
  });

  it("toggles a checkbox and picks one radio of its group, before the click", () => {
    const { click, Menu, model } = setUp();
    const seen: boolean[] = [];
    const menu = Menu.buildFromTemplate([
      {
        click: (item) => seen.push(item.checked),
        label: "Pin",
        type: "checkbox",
      },
      { checked: true, label: "Small", type: "radio" },
      { label: "Large", type: "radio" },
      { type: "separator" },
      { checked: true, label: "Other group", type: "radio" },
    ]);
    const ids = model(menu).map(({ id }) => id);

    click(menu, ids[0] ?? 0);
    click(menu, ids[2] ?? 0);

    expect(seen).toEqual([true]);
    expect(menu.items.map(({ checked }) => checked)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it("runs a role's action, and fails loudly for one not carried out yet", () => {
    const { click, did, Menu, model } = setUp();
    const menu = Menu.buildFromTemplate([{ role: "quit" }, { role: "zoomIn" }]);
    const [quit, zoom] = model(menu);

    click(menu, quit?.id ?? 0);

    expect(did).toEqual(["quit"]);
    expect(() => click(menu, zoom?.id ?? 0)).toThrow(
      'the "zoomIn" menu role is not carried out on Domicile yet',
    );
  });

  it("finds an item in a submenu", () => {
    const { click, Menu, model } = setUp();
    let clicked = false;
    const menu = Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            click: () => {
              clicked = true;
            },
            label: "Save",
          },
        ],
      },
    ]);

    click(menu, model(menu)[0]?.submenu?.[0]?.id ?? 0);

    expect(clicked).toBe(true);
  });
});

describe("a MenuItem's own members", () => {
  it("clicks as a menu does when the app calls its click", () => {
    const { Menu } = setUp();
    const heard: unknown[] = [];
    const menu = Menu.buildFromTemplate([
      { checked: true, label: "Small", type: "radio" },
      {
        click: (item, window, event) =>
          heard.push(item.label, window, event.triggeredByAccelerator),
        label: "Large",
        type: "radio",
      },
    ]);
    const [small, large] = menu.items;

    large?.click(
      {
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        triggeredByAccelerator: true,
      },
      null,
    );

    expect(heard).toEqual(["Large", null, true]);
    expect([small?.checked, large?.checked]).toEqual([false, true]);
  });

  it("knows the menu it is in and whether to register its accelerator", () => {
    const { Menu, MenuItem } = setUp();
    const item = new MenuItem({ label: "Find", registerAccelerator: false });
    const menu = new Menu();

    menu.append(item);

    expect(item.menu).toBe(menu);
    expect(item.registerAccelerator).toBe(false);
    expect(new MenuItem({ label: "Open" }).registerAccelerator).toBe(true);
  });
});

describe("a menu that changes", () => {
  it("says so when an item changes or one is added", () => {
    const { Menu, MenuItem } = setUp();
    const menu = Menu.buildFromTemplate([
      { label: "Sync", submenu: [{ label: "Now" }] },
    ]);
    let changes = 0;
    menu.on("changed", () => {
      changes += 1;
    });

    const now = menu.items[0]?.submenu?.items[0];
    if (now !== undefined) {
      now.enabled = false;
    }
    menu.append(new MenuItem({ label: "More" }));
    menu.insert(0, new MenuItem({ label: "First" }));

    expect(changes).toBe(3);
    expect(menu.items.map(({ label }) => label)).toEqual([
      "First",
      "Sync",
      "More",
    ]);
  });
});

describe("Menu.setApplicationMenu", () => {
  it("hands the menu on, and gives it back", () => {
    const { Menu, shown } = setUp();
    const menu = Menu.buildFromTemplate([{ label: "File" }]);

    Menu.setApplicationMenu(menu);
    expect(Menu.getApplicationMenu()).toBe(menu);
    Menu.setApplicationMenu(null);

    expect(shown).toEqual([menu, null]);
    expect(Menu.getApplicationMenu()).toBeNull();
  });
});

describe("Menu.popup", () => {
  /**
   * A menu module whose windows are names, "main" focused, and the popups
   * it asked the shell for, each with how to answer it.
   */
  const setUp = () => {
    const popups: {
      window: string;
      labels: string[];
      at: { x: number; y: number } | undefined;
      closed: (command: number) => void;
      putAway: number;
    }[] = [];
    const { Menu } = createMenu<string>({
      appName: () => "Claude",
      focusedWindow: () => "main",
      popup: (window, entries, at, closed) => {
        const popup = {
          at,
          closed,
          labels: entries.map((entry) => entry.label),
          putAway: 0,
          window,
        };
        popups.push(popup);
        return () => {
          popup.putAway += 1;
        };
      },
      roles: {},
      setApplicationMenu: () => undefined,
    });
    return { Menu, popups };
  };

  it("pops the menu up over the focused window, where the user pressed", () => {
    const { Menu, popups } = setUp();
    const menu = Menu.buildFromTemplate([{ label: "New Chat" }]);

    menu.popup();

    expect(
      popups.map(({ at, labels, window }) => [window, labels, at]),
    ).toEqual([["main", ["New Chat"], undefined]]);
  });

  it("pops it up over the window and at the point the app names", () => {
    const { Menu, popups } = setUp();
    const menu = Menu.buildFromTemplate([{ label: "New Chat" }]);

    menu.popup({ window: "other", x: 10, y: 20 });

    expect(popups.map(({ at, window }) => [window, at])).toEqual([
      ["other", { x: 10, y: 20 }],
    ]);
  });

  it("refuses x without y", () => {
    const { Menu } = setUp();
    const menu = Menu.buildFromTemplate([{ label: "New Chat" }]);

    expect(() => {
      menu.popup({ x: 10 });
    }).toThrow("Menu.popup takes both x and y, or neither");
  });

  it("runs the entry chosen, then tells the app it closed", () => {
    const { Menu, popups } = setUp();
    const heard: string[] = [];
    const menu = Menu.buildFromTemplate([
      { label: "New Chat" },
      {
        click: (_item, window) => heard.push(`clicked over ${window}`),
        label: "Settings",
      },
    ]);
    menu.on("menu-will-show", () => heard.push("will show"));
    menu.on("menu-will-close", () => heard.push("will close"));

    menu.popup({ callback: () => heard.push("callback") });
    const command = menu.items[1]?.commandId ?? 0;
    popups[0]?.closed(command);

    expect(heard).toEqual([
      "will show",
      "will close",
      "clicked over main",
      "callback",
    ]);
  });

  it("runs nothing when it closes with nothing chosen", () => {
    const { Menu, popups } = setUp();
    const heard: string[] = [];
    const menu = Menu.buildFromTemplate([
      { click: () => heard.push("clicked"), label: "New Chat" },
    ]);

    menu.popup({ callback: () => heard.push("callback") });
    popups[0]?.closed(0);

    expect(heard).toEqual(["callback"]);
  });

  it("puts the popup away on closePopup, and the one before a new popup", () => {
    const { Menu, popups } = setUp();
    const menu = Menu.buildFromTemplate([{ label: "New Chat" }]);

    menu.popup();
    menu.popup();
    menu.closePopup();

    expect(popups.map(({ putAway }) => putAway)).toEqual([1, 1]);
  });
});
