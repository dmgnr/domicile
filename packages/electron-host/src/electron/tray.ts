// The stand-in for Electron's `Tray`: a StatusNotifierItem on the session bus,
// with its context menu served as a `com.canonical.dbusmenu`, as Electron
// does on Linux. Domicile's tray reads both (docs/architecture/SYSTEM-TRAY.md).
//
// Each tray has its own bus connection, so `destroy` takes its icon down: the
// tray forgets an item when the connection that registered it goes.

import { EventEmitter } from "node:events";

import type { MessageBus } from "dbus-next";
import { interface as dbusInterface, Message, Variant } from "dbus-next";

import type { MenuEntry } from "./menu";
import type { NativeImage } from "./native-image";
import { nativeImage } from "./native-image";

const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/MenuBar";
const WATCHER = "org.kde.StatusNotifierWatcher";

/** What the tray needs of the menus: their model, and a click on an entry. */
export type TrayMenus<Menu> = {
  readonly model: (menu: Menu) => MenuEntry[];
  readonly click: (menu: Menu, command: number) => void;
};

export type TrayDependencies<Menu> = {
  /** A new connection to the session bus, one per tray. */
  readonly connect: () => MessageBus;
  /** The app's name: the item's id and title. */
  readonly name: () => string;
  readonly menus: TrayMenus<Menu>;
};

/** An `IconPixmap`: width, height and big-endian ARGB. */
type Pixmap = [number, number, Buffer];

/** `image` as `IconPixmap`'s one picture, or none for an empty image. */
export const pixmapsOf = (image: NativeImage): Pixmap[] => {
  if (image.isEmpty()) {
    return [];
  }
  const { height, width } = image.getSize();
  const bgra = image.toBitmap();
  const argb = Buffer.alloc(bgra.length);
  for (let at = 0; at < bgra.length; at += 4) {
    argb[at] = bgra[at + 3] ?? 0;
    argb[at + 1] = bgra[at + 2] ?? 0;
    argb[at + 2] = bgra[at + 1] ?? 0;
    argb[at + 3] = bgra[at] ?? 0;
  }
  return [[width, height, argb]];
};

/**
 * An Electron label as dbusmenu writes it: Electron's `&` marks a mnemonic and
 * `&&` is an ampersand; dbusmenu's mnemonic mark is `_`, and `__` an
 * underscore.
 */
export const dbusmenuLabel = (label: string) =>
  label.replaceAll(/&&|&|_/g, (mark) => {
    if (mark === "&&") {
      return "&";
    } else if (mark === "&") {
      return "_";
    } else {
      return "__";
    }
  });

/** An entry's dbusmenu properties. */
export const propertiesOf = (entry: MenuEntry): Record<string, Variant> => {
  const properties: Record<string, Variant> = {
    enabled: new Variant("b", entry.enabled),
    visible: new Variant("b", entry.visible),
  };
  if (entry.type === "separator") {
    properties.type = new Variant("s", "separator");
    return properties;
  }
  properties.label = new Variant("s", dbusmenuLabel(entry.label));
  if (entry.type === "checkbox" || entry.type === "radio") {
    properties["toggle-type"] = new Variant(
      "s",
      entry.type === "checkbox" ? "checkmark" : "radio",
    );
    properties["toggle-state"] = new Variant("i", entry.checked ? 1 : 0);
  }
  if (entry.submenu !== undefined) {
    properties["children-display"] = new Variant("s", "submenu");
  }
  if (entry.icon !== undefined) {
    const [, base64 = ""] = entry.icon.split(",", 2);
    properties["icon-data"] = new Variant("ay", Buffer.from(base64, "base64"));
  }
  return properties;
};

/** A dbusmenu layout item, `(ia{sv}av)`. */
type Layout = [number, Record<string, Variant>, Variant[]];

/** The layout under `id`, to `depth` levels (-1 for all), as `GetLayout` answers. */
export const layoutOf = (
  entries: readonly MenuEntry[],
  id: number,
  depth: number,
): Layout => {
  const root: MenuEntry = {
    checked: false,
    enabled: true,
    id: 0,
    label: "",
    sublabel: "",
    submenu: entries,
    toolTip: "",
    type: "submenu",
    visible: true,
  };
  const found = id === 0 ? root : findEntry(entries, id);
  if (found === undefined) {
    throw new Error(`this menu has no entry ${id}`);
  }
  const build = (entry: MenuEntry, left: number): Layout => [
    entry.id,
    entry.id === 0
      ? { "children-display": new Variant("s", "submenu") }
      : propertiesOf(entry),
    left === 0
      ? []
      : (entry.submenu ?? []).map(
          (child) => new Variant("(ia{sv}av)", build(child, left - 1)),
        ),
  ];
  return build(found, depth);
};

const findEntry = (
  entries: readonly MenuEntry[],
  id: number,
): MenuEntry | undefined => {
  for (const entry of entries) {
    if (entry.id === id) {
      return entry;
    }
    const inside = findEntry(entry.submenu ?? [], id);
    if (inside !== undefined) {
      return inside;
    }
  }
  return undefined;
};

/** The parts of a tray its D-Bus objects read. */
type TrayState = {
  readonly name: string;
  readonly toolTip: string;
  readonly pixmaps: Pixmap[];
  readonly hasMenu: boolean;
  readonly clicked: (kind: "click" | "middle-click" | "right-click") => void;
};

/** `org.kde.StatusNotifierItem`. */
class Item extends dbusInterface.Interface {
  constructor(private readonly state: () => TrayState) {
    super("org.kde.StatusNotifierItem");
  }

  get Category() {
    return "ApplicationStatus";
  }
  get Id() {
    return this.state().name;
  }
  get Title() {
    return this.state().name;
  }
  get Status() {
    return "Active";
  }
  get WindowId() {
    return 0;
  }
  get IconThemePath() {
    return "";
  }
  get IconName() {
    return "";
  }
  get IconPixmap() {
    return this.state().pixmaps;
  }
  get OverlayIconName() {
    return "";
  }
  get OverlayIconPixmap() {
    return [];
  }
  get AttentionIconName() {
    return "";
  }
  get AttentionIconPixmap() {
    return [];
  }
  get AttentionMovieName() {
    return "";
  }
  get ToolTip() {
    return ["", [], this.state().toolTip, ""];
  }
  get ItemIsMenu() {
    return false;
  }
  get Menu() {
    return this.state().hasMenu ? MENU_PATH : "/NO_DBUSMENU";
  }

  Activate(_x: number, _y: number) {
    this.state().clicked("click");
  }
  SecondaryActivate(_x: number, _y: number) {
    this.state().clicked("middle-click");
  }
  ContextMenu(_x: number, _y: number) {
    this.state().clicked("right-click");
  }
  Scroll(_delta: number, _orientation: string) {
    // Electron's Linux tray has no scroll event.
  }
  /**
   * The token a click hands over. The engine raises the app's windows itself,
   * as Domicile's own pages, so it needs none.
   */
  ProvideXdgActivationToken(_token: string) {
    // See above.
  }

  NewTitle() {
    return undefined;
  }
  NewIcon() {
    return undefined;
  }
  NewToolTip() {
    return undefined;
  }
  NewStatus(status: string) {
    return status;
  }
}

Item.configureMembers({
  methods: {
    Activate: { inSignature: "ii" },
    ContextMenu: { inSignature: "ii" },
    ProvideXdgActivationToken: { inSignature: "s" },
    Scroll: { inSignature: "is" },
    SecondaryActivate: { inSignature: "ii" },
  },
  properties: {
    AttentionIconName: { access: "read", signature: "s" },
    AttentionIconPixmap: { access: "read", signature: "a(iiay)" },
    AttentionMovieName: { access: "read", signature: "s" },
    Category: { access: "read", signature: "s" },
    IconName: { access: "read", signature: "s" },
    IconPixmap: { access: "read", signature: "a(iiay)" },
    IconThemePath: { access: "read", signature: "s" },
    Id: { access: "read", signature: "s" },
    ItemIsMenu: { access: "read", signature: "b" },
    Menu: { access: "read", signature: "o" },
    OverlayIconName: { access: "read", signature: "s" },
    OverlayIconPixmap: { access: "read", signature: "a(iiay)" },
    Status: { access: "read", signature: "s" },
    Title: { access: "read", signature: "s" },
    ToolTip: { access: "read", signature: "(sa(iiay)ss)" },
    WindowId: { access: "read", signature: "i" },
  },
  signals: {
    NewIcon: { signature: "" },
    NewStatus: { signature: "s" },
    NewTitle: { signature: "" },
    NewToolTip: { signature: "" },
  },
});

/** `com.canonical.dbusmenu`, serving the tray's context menu. */
class DbusMenu extends dbusInterface.Interface {
  revision = 1;

  constructor(
    private readonly entries: () => readonly MenuEntry[],
    private readonly clicked: (id: number) => void,
  ) {
    super("com.canonical.dbusmenu");
  }

  get Version() {
    return 3;
  }
  get TextDirection() {
    return "ltr";
  }
  get Status() {
    return "normal";
  }
  get IconThemePath() {
    return [];
  }

  GetLayout(parent: number, depth: number, _names: string[]) {
    return [this.revision, layoutOf(this.entries(), parent, depth)];
  }

  GetGroupProperties(ids: number[], _names: string[]) {
    const entries = this.entries();
    const wanted = ids.length === 0 ? allIds(entries) : ids;
    return wanted.flatMap((id) => {
      const entry = findEntry(entries, id);
      return entry === undefined ? [] : [[id, propertiesOf(entry)]];
    });
  }

  GetProperty(id: number, name: string) {
    const entry = findEntry(this.entries(), id);
    const value = entry && propertiesOf(entry)[name];
    if (value === undefined) {
      throw new Error(`this menu's entry ${id} has no ${name}`);
    }
    return value;
  }

  Event(id: number, event: string, _data: Variant, _timestamp: number) {
    if (event === "clicked") {
      this.clicked(id);
    }
  }

  EventGroup(events: [number, string, Variant, number][]) {
    for (const [id, event, data, timestamp] of events) {
      this.Event(id, event, data, timestamp);
    }
    return [];
  }

  /** Nothing changes as the menu opens: the app sets it ahead of time. */
  AboutToShow(_id: number) {
    return false;
  }

  AboutToShowGroup(_ids: number[]) {
    return [[], []];
  }

  LayoutUpdated(revision: number, parent: number) {
    return [revision, parent];
  }
}

const allIds = (entries: readonly MenuEntry[]): number[] =>
  entries.flatMap((entry) => [entry.id, ...allIds(entry.submenu ?? [])]);

DbusMenu.configureMembers({
  methods: {
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aiai" },
    Event: { inSignature: "isvu" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ai" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetProperty: { inSignature: "is", outSignature: "v" },
  },
  properties: {
    IconThemePath: { access: "read", signature: "as" },
    Status: { access: "read", signature: "s" },
    TextDirection: { access: "read", signature: "s" },
    Version: { access: "read", signature: "u" },
  },
  signals: {
    LayoutUpdated: { signature: "ui" },
  },
});

type Rectangle = { x: number; y: number; width: number; height: number };

/** The keys held for a click: none, as a tray click doesn't say. */
const NO_KEYS = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  preventDefault: () => undefined,
  shiftKey: false,
};

const NO_BOUNDS: Rectangle = { height: 0, width: 0, x: 0, y: 0 };

/** A menu as the tray watches it: it says when it changes, and has submenus. */
type WatchedMenu = EventEmitter & {
  readonly items: readonly { readonly submenu: WatchedMenu | undefined }[];
};

/** Builds Electron's `Tray` for one app; `Menu` is its `Menu` class. */
export const createTray = <Menu extends WatchedMenu>(
  dependencies: TrayDependencies<Menu>,
) => {
  class Tray extends EventEmitter {
    #bus: MessageBus | undefined;
    #image: NativeImage;
    #toolTip = "";
    #title = "";
    #menu: Menu | null = null;
    /** The menus a change in shows up from: the context menu and its submenus. */
    #watched = new Set<WatchedMenu>();
    readonly #item: Item;
    readonly #dbusMenu: DbusMenu;
    readonly #menuChanged = () => {
      this.#watch();
      this.#dbusMenu.revision += 1;
      this.#dbusMenu.LayoutUpdated(this.#dbusMenu.revision, 0);
    };

    constructor(image: NativeImage | string, _guid?: string) {
      super();
      this.#image = imageOf(image);
      this.#item = new Item(() => ({
        clicked: (kind) => {
          this.emit(kind, NO_KEYS, NO_BOUNDS, { x: 0, y: 0 });
        },
        hasMenu: this.#menu !== null,
        name: dependencies.name(),
        pixmaps: pixmapsOf(this.#image),
        toolTip: this.#toolTip,
      }));
      this.#dbusMenu = new DbusMenu(
        () => (this.#menu === null ? [] : dependencies.menus.model(this.#menu)),
        (id) => {
          if (this.#menu !== null) {
            dependencies.menus.click(this.#menu, id);
          }
        },
      );
      const bus = dependencies.connect();
      this.#bus = bus;
      bus.export(ITEM_PATH, this.#item);
      bus.export(MENU_PATH, this.#dbusMenu);
      // A desktop with no tray is Domicile's bug, not the app's: let it show.
      void register(bus);
    }

    readonly setImage = (image: NativeImage | string) => {
      this.#image = imageOf(image);
      this.#alive()?.NewIcon();
    };

    /** The image while pressed, on macOS. */
    readonly setPressedImage = (_image: NativeImage | string) => undefined;

    readonly setToolTip = (toolTip: string) => {
      this.#toolTip = toolTip;
      this.#alive()?.NewToolTip();
    };

    /** Shown beside the icon on macOS; kept for getTitle elsewhere. */
    readonly setTitle = (title: string, _options?: object) => {
      this.#title = title;
    };

    readonly getTitle = () => this.#title;

    readonly setContextMenu = (menu: Menu | null) => {
      const had = this.#menu !== null;
      this.#menu = menu;
      this.#watch();
      if (this.#alive() !== undefined) {
        if (had !== (menu !== null)) {
          // The item's Menu property changed: the tray reads it again.
          this.#item.NewStatus("Active");
        }
        this.#menuChanged();
      }
    };

    /** Electron's double-click setting is macOS's and Windows'. */
    readonly setIgnoreDoubleClickEvents = (_ignore: boolean) => undefined;
    readonly getIgnoreDoubleClickEvents = () => false;

    /** Balloons are Windows'. */
    readonly displayBalloon = (_options: object) => undefined;
    readonly removeBalloon = () => undefined;
    readonly focus = () => undefined;

    /** Opening the menu is the shell's, on a click on the icon. */
    readonly popUpContextMenu = (_menu?: Menu, _position?: object) => undefined;
    readonly closeContextMenu = () => undefined;

    /** Where the icon is: the shell's, and not told. */
    readonly getBounds = () => ({ ...NO_BOUNDS });

    readonly isDestroyed = () => this.#bus === undefined;

    readonly destroy = () => {
      this.#bus?.disconnect();
      this.#bus = undefined;
      this.#menu = null;
      this.#watch();
    };

    /** The item, while the tray is up. */
    #alive() {
      return this.#bus === undefined ? undefined : this.#item;
    }

    /** Listens for changes on the context menu and every submenu in it. */
    #watch() {
      for (const menu of this.#watched) {
        menu.off("changed", this.#menuChanged);
      }
      this.#watched = new Set();
      const visit = (menu: WatchedMenu) => {
        if (this.#watched.has(menu)) {
          return;
        }
        this.#watched.add(menu);
        menu.on("changed", this.#menuChanged);
        for (const item of menu.items) {
          if (item.submenu !== undefined) {
            visit(item.submenu);
          }
        }
      };
      if (this.#menu !== null && this.#bus !== undefined) {
        visit(this.#menu);
      }
    }
  }

  return Tray;
};

const imageOf = (image: NativeImage | string) =>
  typeof image === "string" ? nativeImage.createFromPath(image) : image;

/** Registers the item at `/StatusNotifierItem` on `bus` with the tray. */
const register = async (bus: MessageBus) => {
  await bus.call(
    new Message({
      body: [ITEM_PATH],
      destination: WATCHER,
      interface: WATCHER,
      member: "RegisterStatusNotifierItem",
      path: "/StatusNotifierWatcher",
      signature: "s",
    }),
  );
};
