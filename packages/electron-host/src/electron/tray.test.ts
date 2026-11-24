import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { MessageBus } from "dbus-next";
import { sessionBus, Variant } from "dbus-next";

import { startFakeDesktopBus } from "../desktop-bus-fixture";
import { encodePng } from "../png";
import { createMenu } from "./menu";
import { nativeImage } from "./native-image";
import { createTray, dbusmenuLabel, layoutOf, pixmapsOf } from "./tray";

/** 2x1: opaque red, then half-clear blue. */
const RED_BLUE = nativeImage.createFromBuffer(
  Buffer.from(
    encodePng({
      height: 1,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]),
      width: 2,
    }),
  ),
);

describe("dbusmenuLabel", () => {
  it("turns Electron's mnemonics into dbusmenu's", () => {
    expect(dbusmenuLabel("&Quit")).toBe("_Quit");
    expect(dbusmenuLabel("Salt && Pepper")).toBe("Salt & Pepper");
    expect(dbusmenuLabel("snake_case")).toBe("snake__case");
  });
});

describe("pixmapsOf", () => {
  it("gives an image as big-endian ARGB", () => {
    expect(pixmapsOf(RED_BLUE)).toEqual([
      [2, 1, Buffer.from([255, 255, 0, 0, 128, 0, 0, 255])],
    ]);
  });

  it("gives none for an empty image", () => {
    expect(pixmapsOf(nativeImage.createEmpty())).toEqual([]);
  });
});

describe("layoutOf", () => {
  const { Menu, model } = createMenu({
    appName: () => "Notes",
    focusedWindow: () => null,
    popup: () => {
      throw new Error("a tray's menu pops up nowhere in these tests");
    },
    roles: {},
    setApplicationMenu: () => undefined,
  });
  const menu = Menu.buildFromTemplate([
    { label: "&Open" },
    { type: "separator" },
    { checked: true, label: "Pin", type: "checkbox" },
    { label: "Recent", submenu: [{ label: "Groceries" }] },
  ]);
  const entries = model(menu);

  it("lays out the whole menu under the root", () => {
    const [root, properties, children] = layoutOf(entries, 0, -1);
    expect(root).toBe(0);
    expect(properties["children-display"]?.value).toBe("submenu");
    const [open, separator, pin, recent] = children.map(
      ({ value }) => value as ReturnType<typeof layoutOf>,
    );
    expect(open?.[1].label?.value).toBe("_Open");
    expect(separator?.[1].type?.value).toBe("separator");
    expect(pin?.[1]["toggle-type"]?.value).toBe("checkmark");
    expect(pin?.[1]["toggle-state"]?.value).toBe(1);
    expect(recent?.[1]["children-display"]?.value).toBe("submenu");
    expect(recent?.[2]).toHaveLength(1);
  });

  it("stops at the depth asked for, and starts at the entry asked for", () => {
    expect(layoutOf(entries, 0, 1)[2][3]?.value[2]).toEqual([]);
    const recent = entries[3]?.id ?? -1;
    expect(layoutOf(entries, recent, -1)[2]).toHaveLength(1);
  });

  it("refuses an entry it hasn't got", () => {
    expect(() => layoutOf(entries, 999, -1)).toThrow("no entry 999");
  });
});

describe("Tray", () => {
  let desktopBus: Awaited<ReturnType<typeof startFakeDesktopBus>>;
  let client: MessageBus;
  beforeAll(async () => {
    desktopBus = await startFakeDesktopBus({ colorScheme: 0, contrast: 0 });
    client = sessionBus({ busAddress: desktopBus.address });
  });
  afterAll(async () => {
    client.disconnect();
    await desktopBus.close();
  });

  const setUp = () => {
    const { click, Menu, MenuItem, model } = createMenu({
      appName: () => "Slack",
      focusedWindow: () => null,
      popup: () => {
        throw new Error("a tray's menu pops up nowhere in these tests");
      },
      roles: {},
      setApplicationMenu: () => undefined,
    });
    const Tray = createTray({
      connect: () => sessionBus({ busAddress: desktopBus.address }),
      menus: { click, model },
      name: () => "Slack",
    });
    return { Menu, MenuItem, Tray };
  };

  /** The item the tray registered last, once it has. */
  const registeredItem = async () => {
    const count = desktopBus.registered.length;
    while (desktopBus.registered.length === count) {
      await Bun.sleep(5);
    }
    const item = desktopBus.registered.at(-1);
    if (item === undefined) {
      throw new Error("test: nothing registered");
    }
    return item;
  };

  /** A proxy of `name` at `path` on `sender`, calling by method name. */
  const proxy = async (sender: string, path: string, name: string) => {
    const proxied = (await client.getProxyObject(sender, path)).getInterface(
      name,
    );
    const call = (method: string, ...args: unknown[]): Promise<unknown> => {
      const found = proxied[method];
      if (found === undefined) {
        throw new Error(`test: ${name} has no ${method}`);
      }
      return found(...args);
    };
    return { call, proxied };
  };

  const properties = async (sender: string) => {
    const read = await proxy(
      sender,
      "/StatusNotifierItem",
      "org.freedesktop.DBus.Properties",
    );
    const all = (await read.call(
      "GetAll",
      "org.kde.StatusNotifierItem",
    )) as Record<string, Variant>;
    return Object.fromEntries(
      Object.entries(all).map(([key, { value }]) => [key, value]),
    );
  };

  it("registers an item with its icon, tooltip and name", async () => {
    const { Tray } = setUp();
    const registering = registeredItem();
    const tray = new Tray(RED_BLUE);
    tray.setToolTip("Slack: 2 unread");
    const { sender, service } = await registering;

    expect(service).toBe("/StatusNotifierItem");
    const read = await properties(sender);
    expect(read.Id).toBe("Slack");
    expect(read.Status).toBe("Active");
    expect(read.IconPixmap).toEqual([
      [2, 1, Buffer.from([255, 255, 0, 0, 128, 0, 0, 255])],
    ]);
    expect(read.ToolTip).toEqual(["", [], "Slack: 2 unread", ""]);
    expect(read.Menu).toBe("/NO_DBUSMENU");
    tray.destroy();
  });

  it("tells the app about clicks on its icon", async () => {
    const { Tray } = setUp();
    const registering = registeredItem();
    const tray = new Tray(RED_BLUE);
    const heard: string[] = [];
    for (const kind of ["click", "middle-click", "right-click"]) {
      tray.on(kind, () => heard.push(kind));
    }
    const { sender } = await registering;
    const item = await proxy(
      sender,
      "/StatusNotifierItem",
      "org.kde.StatusNotifierItem",
    );

    await item.call("ProvideXdgActivationToken", "token");
    await item.call("Activate", 0, 0);
    await item.call("SecondaryActivate", 0, 0);
    await item.call("ContextMenu", 0, 0);

    expect(heard).toEqual(["click", "middle-click", "right-click"]);
    tray.destroy();
  });

  it("serves its context menu, and clicks it", async () => {
    const { Menu, Tray } = setUp();
    const registering = registeredItem();
    const tray = new Tray(RED_BLUE);
    const clicked: string[] = [];
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { click: () => clicked.push("show"), label: "Show Slack" },
        { label: "Quit" },
      ]),
    );
    const { sender } = await registering;
    expect((await properties(sender)).Menu).toBe("/MenuBar");
    const menu = await proxy(sender, "/MenuBar", "com.canonical.dbusmenu");

    const [, layout] = (await menu.call("GetLayout", 0, -1, [])) as [
      number,
      [number, unknown, Variant[]],
    ];
    const [show] = layout[2].map(
      ({ value }) => value as [number, Record<string, Variant>, Variant[]],
    );
    expect(show?.[1].label?.value).toBe("Show Slack");
    await menu.call("Event", show?.[0], "clicked", new Variant("i", 0), 0);

    expect(clicked).toEqual(["show"]);
    tray.destroy();
  });

  it("says when its menu changes, inside a submenu too", async () => {
    const { Menu, MenuItem, Tray } = setUp();
    const registering = registeredItem();
    const tray = new Tray(RED_BLUE);
    const contextMenu = Menu.buildFromTemplate([
      { label: "Status", submenu: [{ label: "Away" }] },
    ]);
    tray.setContextMenu(contextMenu);
    const { sender } = await registering;
    const menu = await proxy(sender, "/MenuBar", "com.canonical.dbusmenu");
    const revisions: unknown[] = [];
    menu.proxied.on("LayoutUpdated", (revision: unknown) => {
      revisions.push(revision);
    });
    const [before] = (await menu.call("GetLayout", 0, -1, [])) as [number];

    contextMenu.items[0]?.submenu?.append(new MenuItem({ label: "Busy" }));
    while (revisions.length === 0) {
      await Bun.sleep(5);
    }

    const [after, layout] = (await menu.call("GetLayout", 0, -1, [])) as [
      number,
      [number, unknown, Variant[]],
    ];
    expect(after).toBeGreaterThan(before);
    const status = layout[2][0]?.value as [number, unknown, Variant[]];
    expect(status[2]).toHaveLength(2);
    tray.destroy();
  });

  it("takes its icon down when destroyed", async () => {
    const { Tray } = setUp();
    const registering = registeredItem();
    const tray = new Tray(RED_BLUE);
    const { sender } = await registering;
    const daemon = await proxy(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
    );
    expect(await daemon.call("NameHasOwner", sender)).toBe(true);

    tray.destroy();
    expect(tray.isDestroyed()).toBe(true);
    while ((await daemon.call("NameHasOwner", sender)) === true) {
      await Bun.sleep(5);
    }
  });
});
