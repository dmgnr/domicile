// The stand-ins for Electron's `Menu` and `MenuItem`: a menu the app builds,
// which the tray and the app menu bar draw from its model and click by the
// numbers in it. Roles get Electron's labels and accelerators on Linux, and
// carry out what the host can do; a role it can't do yet fails loudly when
// clicked. See "Desktop pieces" in docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";

import type { NativeImage } from "./native-image";
import { nativeImage } from "./native-image";

export type MenuItemType =
  | "normal"
  | "separator"
  | "submenu"
  | "checkbox"
  | "radio";

/** What a role does, and how it looks when the app gives no label. */
type RoleSpec = {
  readonly label: string;
  readonly accelerator?: string;
  /** Roles only macOS has: hidden elsewhere, as Electron hides them. */
  readonly macOnly?: true;
  /** A role that is a whole menu, built from these roles. */
  readonly submenu?: readonly string[];
};

const ROLES = {
  about: { label: "About {app}" },
  appMenu: { label: "{app}", macOnly: true },
  clearRecentDocuments: { label: "Clear Menu", macOnly: true },
  close: { accelerator: "CommandOrControl+W", label: "Close" },
  copy: { accelerator: "CommandOrControl+C", label: "Copy" },
  cut: { accelerator: "CommandOrControl+X", label: "Cut" },
  delete: { label: "Delete" },
  editMenu: {
    label: "Edit",
    submenu: [
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "delete",
      "separator",
      "selectAll",
    ],
  },
  fileMenu: { label: "File", submenu: ["quit"] },
  forceReload: {
    accelerator: "Shift+CommandOrControl+R",
    label: "Force Reload",
  },
  front: { label: "Bring All to Front", macOnly: true },
  help: { label: "Help" },
  hide: { label: "Hide {app}", macOnly: true },
  hideOthers: { label: "Hide Others", macOnly: true },
  mergeAllWindows: { label: "Merge All Windows", macOnly: true },
  minimize: { accelerator: "CommandOrControl+M", label: "Minimize" },
  moveTabToNewWindow: { label: "Move Tab to New Window", macOnly: true },
  paste: { accelerator: "CommandOrControl+V", label: "Paste" },
  pasteAndMatchStyle: {
    accelerator: "Shift+CommandOrControl+V",
    label: "Paste and Match Style",
  },
  quit: { accelerator: "CommandOrControl+Q", label: "Quit" },
  recentDocuments: { label: "Open Recent", macOnly: true },
  redo: { accelerator: "Shift+CommandOrControl+Z", label: "Redo" },
  reload: { accelerator: "CommandOrControl+R", label: "Reload" },
  resetZoom: { accelerator: "CommandOrControl+0", label: "Actual Size" },
  selectAll: { accelerator: "CommandOrControl+A", label: "Select All" },
  selectNextTab: { label: "Select Next Tab", macOnly: true },
  selectPreviousTab: { label: "Select Previous Tab", macOnly: true },
  services: { label: "Services", macOnly: true },
  shareMenu: { label: "Share", macOnly: true },
  showAllTabs: { label: "Show All Tabs", macOnly: true },
  showSubstitutions: { label: "Show Substitutions", macOnly: true },
  startSpeaking: { label: "Start Speaking", macOnly: true },
  stopSpeaking: { label: "Stop Speaking", macOnly: true },
  toggleDevTools: {
    accelerator: "Control+Shift+I",
    label: "Toggle Developer Tools",
  },
  togglefullscreen: { accelerator: "F11", label: "Toggle Full Screen" },
  toggleSmartDashes: { label: "Smart Dashes", macOnly: true },
  toggleSmartQuotes: { label: "Smart Quotes", macOnly: true },
  toggleSmartSubstitutions: { label: "Text Replacement", macOnly: true },
  toggleSpellChecker: { label: "Check Spelling While Typing" },
  toggleTabBar: { label: "Show Tab Bar", macOnly: true },
  undo: { accelerator: "CommandOrControl+Z", label: "Undo" },
  unhide: { label: "Show All", macOnly: true },
  viewMenu: {
    label: "View",
    submenu: [
      "reload",
      "forceReload",
      "toggleDevTools",
      "separator",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "separator",
      "togglefullscreen",
    ],
  },
  window: { label: "Window" },
  windowMenu: { label: "Window", submenu: ["minimize", "close"] },
  zoom: { label: "Zoom", macOnly: true },
  zoomIn: { accelerator: "CommandOrControl+Plus", label: "Zoom In" },
  zoomOut: { accelerator: "CommandOrControl+-", label: "Zoom Out" },
} as const satisfies Record<string, RoleSpec>;

export type Role = keyof typeof ROLES;

/** What a click sends after the item and its window, as Electron's does. */
export type ClickEvent = {
  readonly triggeredByAccelerator: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
};

export type MenuItemOptions<Window> = {
  click?: (
    item: MenuItem<Window>,
    window: Window | null,
    event: ClickEvent,
  ) => void;
  role?: Role;
  type?: MenuItemType;
  label?: string;
  sublabel?: string;
  toolTip?: string;
  accelerator?: string;
  icon?: NativeImage | string;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  registerAccelerator?: boolean;
  acceleratorWorksWhenHidden?: boolean;
  submenu?: readonly MenuItemOptions<Window>[] | Menu<Window>;
  id?: string;
  before?: readonly string[];
  after?: readonly string[];
  beforeGroupContaining?: readonly string[];
  afterGroupContaining?: readonly string[];
};

/** A menu entry as the tray and the menu bar draw it. */
export type MenuEntry = {
  readonly id: number;
  readonly type: MenuItemType;
  readonly label: string;
  readonly sublabel: string;
  readonly toolTip: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly checked: boolean;
  /** As the app wrote it, such as `CmdOrCtrl+Shift+N`. */
  readonly accelerator?: string;
  /** A PNG `data:` URL. */
  readonly icon?: string;
  readonly submenu?: readonly MenuEntry[];
};

/** Electron's `MenuItem`, as built here; `Window` is the app's BrowserWindow. */
export type MenuItem<Window> = {
  readonly id: string;
  readonly commandId: number;
  readonly role: Role | undefined;
  readonly type: MenuItemType;
  readonly submenu: Menu<Window> | undefined;
  readonly accelerator: string | undefined;
  readonly icon: NativeImage | undefined;
  /** The menu it was last put in. */
  readonly menu: Menu<Window> | undefined;
  /** Clicks it as its menu would: toggles it, then its click or its role. */
  click: (event?: ClickEvent, window?: Window | null) => void;
  registerAccelerator: boolean;
  label: string;
  sublabel: string;
  toolTip: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  /** Each menu that holds it: told when it changes. */
  readonly menus: Set<Menu<Window>>;
};

/** Electron's `Menu`, as built here. */
export type Menu<Window> = EventEmitter & {
  readonly items: MenuItem<Window>[];
  append(item: MenuItem<Window>): void;
  insert(position: number, item: MenuItem<Window>): void;
  getMenuItemById(id: string): MenuItem<Window> | null;
  popup(options?: PopupOptions<Window>): void;
  closePopup(window?: Window): void;
};

/** `Menu.popup`'s options, as far as Domicile carries them out. */
export type PopupOptions<Window> = {
  /** The window it goes over; the focused one if left out. */
  readonly window?: Window;
  /** Where, in CSS pixels from the window's page; else the last press. */
  readonly x?: number;
  readonly y?: number;
  /** Called once it closes, after any entry chosen ran. */
  readonly callback?: () => void;
  // macOS's alone, or where an entry goes over the point: neither moves it.
  readonly positioningItem?: number;
  readonly sourceType?: string;
  readonly frame?: unknown;
};

/** What the menus reach outside themselves. */
export type MenuDependencies<Window> = {
  readonly appName: () => string;
  readonly focusedWindow: () => Window | null;
  /**
   * Has the shell draw `entries` over `window`, at `at` or where the user
   * last pressed. `closed` hears the entry chosen, or 0 for none; the
   * function returned puts it away.
   */
  readonly popup: (
    window: Window,
    entries: readonly MenuEntry[],
    at: { x: number; y: number } | undefined,
    closed: (command: number) => void,
  ) => () => void;
  /** What each role does, for those the host carries out. */
  readonly roles: Partial<Record<Role, (window: Window | null) => void>>;
  /** Shows the app's menu bar, or none. */
  readonly setApplicationMenu: (menu: Menu<Window> | null) => void;
};

const isRole = (role: string): role is Role => Object.hasOwn(ROLES, role);

const NO_KEYS: ClickEvent = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  triggeredByAccelerator: false,
};

/**
 * Orders `items` by their `before` and `after`, as Electron does for the ids
 * they name; the rest keep their order. Group positions keep template order.
 */
const placed = <T extends { id: string }>(
  items: readonly {
    item: T;
    before?: readonly string[] | undefined;
    after?: readonly string[] | undefined;
  }[],
): T[] => {
  const ordered: T[] = [];
  const later: (typeof items)[number][] = [];
  for (const entry of items) {
    if (entry.before === undefined && entry.after === undefined) {
      ordered.push(entry.item);
    } else {
      later.push(entry);
    }
  }
  for (const { after, before, item } of later) {
    const beforeAt = ordered.findIndex(({ id }) => before?.includes(id));
    const afterAt = ordered.findLastIndex(({ id }) => after?.includes(id));
    if (beforeAt !== -1) {
      ordered.splice(beforeAt, 0, item);
    } else if (afterAt === -1) {
      ordered.push(item);
    } else {
      ordered.splice(afterAt + 1, 0, item);
    }
  }
  return ordered;
};

/**
 * Makes `Menu` and `MenuItem` for an app, with `model`, what the tray and the
 * menu bar draw, and `click`, which they call with an entry's number.
 */
export const createMenu = <Window>(dependencies: MenuDependencies<Window>) => {
  let nextCommand = 1;
  let applicationMenu: Menu<Window> | null = null;

  const changed = (item: MenuItem<Window>) => {
    for (const menu of item.menus) {
      menu.emit("changed");
    }
  };

  const iconOf = (icon: NativeImage | string | undefined) =>
    typeof icon === "string" ? nativeImage.createFromPath(icon) : icon;

  /** A submenu given as a menu or a template, built if a template. */
  const submenuOf = (
    submenu: readonly MenuItemOptions<Window>[] | Menu<Window> | undefined,
  ): Menu<Window> | undefined => {
    if (submenu === undefined || submenu instanceof MenuImpl) {
      return submenu;
    } else {
      return Menu.buildFromTemplate(
        submenu as readonly MenuItemOptions<Window>[],
      );
    }
  };

  class MenuItemImpl implements MenuItem<Window> {
    readonly id: string;
    readonly commandId = nextCommand++;
    readonly role: Role | undefined;
    readonly type: MenuItemType;
    readonly submenu: Menu<Window> | undefined;
    readonly accelerator: string | undefined;
    readonly icon: NativeImage | undefined;
    readonly menus = new Set<Menu<Window>>();
    registerAccelerator: boolean;
    readonly #onClick: MenuItemOptions<Window>["click"];
    #label: string;
    #sublabel: string;
    #toolTip: string;
    #enabled: boolean;
    #visible: boolean;
    #checked: boolean;

    constructor(options: MenuItemOptions<Window>) {
      const role = options.role;
      if (role !== undefined && !isRole(role)) {
        throw new TypeError(
          `${JSON.stringify(role)} is not a menu item role Electron has`,
        );
      }
      const spec: RoleSpec | undefined =
        role === undefined ? undefined : ROLES[role];
      const submenu =
        options.submenu ??
        spec?.submenu?.map(
          (entry): MenuItemOptions<Window> =>
            entry === "separator"
              ? { type: "separator" }
              : { role: entry as Role },
        );
      this.id = options.id ?? `${this.commandId}`;
      this.role = role;
      this.submenu = submenuOf(submenu);
      this.type =
        options.type ?? (this.submenu === undefined ? "normal" : "submenu");
      this.accelerator = options.accelerator ?? spec?.accelerator;
      this.icon = iconOf(options.icon);
      this.#onClick = options.click;
      this.registerAccelerator = options.registerAccelerator ?? true;
      this.#label =
        options.label ??
        spec?.label.replace("{app}", dependencies.appName()) ??
        "";
      this.#sublabel = options.sublabel ?? "";
      this.#toolTip = options.toolTip ?? "";
      this.#enabled = options.enabled ?? true;
      this.#visible = options.visible ?? spec?.macOnly !== true;
      this.#checked = options.checked ?? false;
      // A change inside its submenu is a change to every menu holding it.
      this.submenu?.on("changed", () => changed(this));
    }

    get menu() {
      return [...this.menus].at(-1);
    }

    click = (
      event: ClickEvent = NO_KEYS,
      window: Window | null = dependencies.focusedWindow(),
    ) => {
      if (this.type === "checkbox") {
        this.checked = !this.checked;
      } else if (this.type === "radio") {
        for (const radio of this.menu === undefined
          ? [this]
          : radioGroup(this.menu, this)) {
          radio.checked = radio === this;
        }
      }
      if (this.#onClick !== undefined) {
        this.#onClick(this, window, event);
      } else if (this.role !== undefined) {
        const action = dependencies.roles[this.role];
        if (action === undefined) {
          throw new Error(
            `the ${JSON.stringify(this.role)} menu role is not carried out on Domicile yet`,
          );
        }
        action(window);
      }
    };

    get label() {
      return this.#label;
    }
    set label(value: string) {
      this.#label = value;
      changed(this);
    }
    get sublabel() {
      return this.#sublabel;
    }
    set sublabel(value: string) {
      this.#sublabel = value;
      changed(this);
    }
    get toolTip() {
      return this.#toolTip;
    }
    set toolTip(value: string) {
      this.#toolTip = value;
      changed(this);
    }
    get enabled() {
      return this.#enabled;
    }
    set enabled(value: boolean) {
      this.#enabled = value;
      changed(this);
    }
    get visible() {
      return this.#visible;
    }
    set visible(value: boolean) {
      this.#visible = value;
      changed(this);
    }
    get checked() {
      return this.#checked;
    }
    set checked(value: boolean) {
      this.#checked = value;
      changed(this);
    }
  }

  class MenuImpl extends EventEmitter implements Menu<Window> {
    readonly items: MenuItem<Window>[] = [];

    append(item: MenuItem<Window>) {
      this.insert(this.items.length, item);
    }

    insert(position: number, item: MenuItem<Window>) {
      this.items.splice(position, 0, item);
      item.menus.add(this);
      this.emit("changed");
    }

    getMenuItemById(id: string): MenuItem<Window> | null {
      for (const item of this.items) {
        if (item.id === id) {
          return item;
        }
        const inside = item.submenu?.getMenuItemById(id) ?? null;
        if (inside !== null) {
          return inside;
        }
      }
      return null;
    }

    /** What puts each window's popup of this menu away. */
    readonly #popups = new Map<Window, () => void>();

    /** The shell draws the menu over the window, as its menu bar's menus. */
    popup(options: PopupOptions<Window> = {}) {
      const window = options.window ?? dependencies.focusedWindow();
      if (window === null) {
        throw new Error(
          "Menu.popup has no window to go over: no window is focused, and options.window names none",
        );
      }
      const { x, y } = options;
      if ((x === undefined) !== (y === undefined)) {
        throw new TypeError(
          "Menu.popup takes both x and y, or neither, as Domicile places it",
        );
      }
      this.#popups.get(window)?.();
      this.emit("menu-will-show", { preventDefault: () => undefined });
      const close = dependencies.popup(
        window,
        model(this),
        x === undefined || y === undefined ? undefined : { x, y },
        (command) => {
          if (this.#popups.get(window) === close) {
            this.#popups.delete(window);
          }
          this.emit("menu-will-close", { preventDefault: () => undefined });
          if (command > 0) {
            click(this, command, NO_KEYS, window);
          }
          options.callback?.();
        },
      );
      this.#popups.set(window, close);
    }

    closePopup(window?: Window) {
      const over = window ?? dependencies.focusedWindow();
      if (over === null) {
        for (const close of this.#popups.values()) {
          close();
        }
      } else {
        this.#popups.get(over)?.();
      }
    }
  }

  const Menu = Object.assign(MenuImpl, {
    buildFromTemplate: (template: readonly MenuItemOptions<Window>[]) => {
      const menu = new MenuImpl();
      const items = template.map((options) => ({
        after: options.after,
        before: options.before,
        item: new MenuItemImpl(options),
      }));
      for (const item of placed(items)) {
        menu.append(item);
      }
      return menu;
    },
    getApplicationMenu: () => applicationMenu,
    /** macOS's responder chain; nothing answers elsewhere. */
    sendActionToFirstResponder: (_action: string) => undefined,
    setApplicationMenu: (menu: Menu<Window> | null) => {
      applicationMenu = menu;
      dependencies.setApplicationMenu(menu);
    },
  });

  /** The entries the tray and the menu bar draw, numbered for a click. */
  const model = (menu: Menu<Window>): MenuEntry[] =>
    menu.items.map((item) => ({
      checked: item.checked,
      enabled: item.enabled,
      id: item.commandId,
      label: item.label,
      sublabel: item.sublabel,
      toolTip: item.toolTip,
      type: item.type,
      visible: item.visible,
      ...(item.accelerator === undefined
        ? {}
        : { accelerator: item.accelerator }),
      ...(item.icon === undefined || item.icon.isEmpty()
        ? {}
        : { icon: item.icon.toDataURL() }),
      ...(item.submenu === undefined ? {} : { submenu: model(item.submenu) }),
    }));

  const find = (
    menu: Menu<Window>,
    command: number,
  ): { item: MenuItem<Window>; menu: Menu<Window> } | undefined => {
    for (const item of menu.items) {
      if (item.commandId === command) {
        return { item, menu };
      }
      const inside = item.submenu && find(item.submenu, command);
      if (inside !== undefined) {
        return inside;
      }
    }
    return undefined;
  };

  /** The radios in `item`'s group: the run of radios around it. */
  const radioGroup = (menu: Menu<Window>, item: MenuItem<Window>) => {
    const at = menu.items.indexOf(item);
    let start = at;
    let end = at;
    while (menu.items[start - 1]?.type === "radio") {
      start -= 1;
    }
    while (menu.items[end + 1]?.type === "radio") {
      end += 1;
    }
    return menu.items.slice(start, end + 1);
  };

  /**
   * Carries out a click on entry `command` of `menu`, as Electron does, for
   * `window`: the one whose menu bar was clicked, or the focused one.
   */
  const click = (
    menu: Menu<Window>,
    command: number,
    event = NO_KEYS,
    window: Window | null = dependencies.focusedWindow(),
  ) => {
    const found = find(menu, command);
    if (found === undefined) {
      // The menu changed under the click: the entry is gone.
      return;
    }
    const { item } = found;
    if (item.enabled && item.visible) {
      item.click(event, window);
    }
  };

  const MenuItem = MenuItemImpl as unknown as new (
    options: MenuItemOptions<Window>,
  ) => MenuItem<Window>;

  return { click, Menu, MenuItem, model };
};
