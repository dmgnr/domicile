import { describe, expect, it } from "bun:test";
import { None, Ok } from "@cprussin/option-result";
import type { watchMenu } from "@domicile-desktop/sdk/dbusmenu";
import { MenuEntry } from "@domicile-desktop/sdk/dbusmenu";
import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  Extension,
  InstalledExtension,
} from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TrayIconsMenu } from "./TrayIconsMenu";

const ICON = "data:image/png;base64,iVBORw0KGgo=";

const sync: TrayItem = {
  bus: ":1.9",
  icon: ICON,
  id: "syncthing",
  itemIsMenu: false,
  menu: undefined,
  title: "Syncthing",
};

/** An application whose menu holds one entry, Open. */
const network: TrayItem = {
  bus: ":1.42",
  icon: ICON,
  id: "network",
  itemIsMenu: false,
  menu: "/MenuBar",
  title: "Network",
};

/** A `watchMenu` that reports {@link network}'s menu, and records its clicks. */
const watchingNetwork =
  (calls: unknown[][]): typeof watchMenu =>
  (_system, _address, onMenu) => {
    onMenu(
      Ok([
        MenuEntry.Item({
          enabled: true,
          icon: undefined,
          id: 1,
          image: undefined,
          label: "Open",
          mnemonic: undefined,
          submenu: undefined,
          toggle: undefined,
        }),
      ]),
    );
    return {
      aboutToShow: () => Promise.resolve(Ok("shown")),
      click: (id) => {
        calls.push(["menu.click", id]);
        return Promise.resolve(Ok("clicked"));
      },
      stop: () => undefined,
    };
  };

const DARK = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OFF = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const darkReader: InstalledExtension = {
  configured: ["fileAccess"],
  enabled: true,
  fileAccess: true,
  fromConfig: false,
  icon: ICON,
  id: DARK,
  name: "Dark Reader",
  optionsUrl: `chrome-extension://${DARK}/options.html`,
  siteAccess: "all_sites",
  sites: [],
  userScripts: undefined,
};

const switchedOff: InstalledExtension = {
  ...darkReader,
  enabled: false,
  id: OFF,
  name: "Switched Off",
};

const darkAction: Extension = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: ICON,
  id: DARK,
  name: "Dark Reader",
  popup: `chrome-extension://${DARK}/popup.html`,
  profile: "default",
  title: "Dark Reader",
};

/** A desk that records each call the menu makes, by name and arguments. */
const recordingDomicile = (calls: unknown[][], refuse = false): Domicile =>
  ({
    browser: {
      open: (...args: unknown[]) => calls.push(["browser.open", ...args]),
      setExtensionEnabled: (...args: unknown[]) => {
        calls.push(["browser.setExtensionEnabled", ...args]);
        return Promise.resolve();
      },
    },
    extensions: {
      activate: (...args: unknown[]) =>
        calls.push(["extensions.activate", ...args]),
      configure: (...args: unknown[]) => {
        calls.push(["extensions.configure", ...args]);
        return Promise.resolve();
      },
      setEnabled: (...args: unknown[]) => {
        calls.push(["extensions.setEnabled", ...args]);
        return refuse
          ? Promise.reject(new DOMException("not installed", "OperationError"))
          : Promise.resolve();
      },
      uninstall: (...args: unknown[]) => {
        calls.push(["extensions.uninstall", ...args]);
        return Promise.resolve();
      },
    },
    tray: {
      activate: (...args: unknown[]) => calls.push(["tray.activate", ...args]),
    },
  }) as unknown as Domicile;

/** A Work profile with Dark Reader off and Switched Off locked on. */
const work: BrowserProfile = {
  color: "#d97706",
  configSites: [],
  enabledExtensions: [OFF],
  extensions: [DARK, OFF],
  id: "work",
  isDefault: false,
  isDefaultPrivate: false,
  isPrivate: false,
  lockedExtensions: [OFF],
  name: "Work",
  pinnedSites: [],
};

type Options = {
  calls?: unknown[][];
  extensions?: readonly Extension[];
  installed?: readonly InstalledExtension[];
  profile?: BrowserProfile;
  refuse?: boolean;
  unpinned?: ReadonlySet<string>;
};

const renderMenu = ({
  calls = [],
  extensions = [darkAction],
  installed = [darkReader, switchedOff],
  profile,
  refuse = false,
  unpinned = new Set(),
}: Options = {}) =>
  render(
    <TrayIconsMenu
      domicile={recordingDomicile(calls, refuse)}
      extensions={extensions}
      icons={() => Promise.resolve(Ok(() => Promise.resolve(Ok(None()))))}
      installed={installed}
      items={[sync, network]}
      onActivate={(id) => calls.push(["onActivate", id])}
      onOpen={(popup) => calls.push(["onOpen", popup])}
      onPin={(key) => calls.push(["onPin", key])}
      onSettings={() => calls.push(["onSettings"])}
      onUnpin={(key) => calls.push(["onUnpin", key])}
      profile={profile}
      unpinned={unpinned}
      watch={watchingNetwork(calls)}
    />,
  );

const openMenu = async () => {
  await userEvent.click(screen.getByRole("button", { name: "All tray icons" }));
  return screen.findByRole("heading", { name: "Tray icons" });
};

describe(TrayIconsMenu, () => {
  it("lists every app and installed extension", async () => {
    renderMenu();

    await openMenu();

    expect(screen.getByRole("button", { name: "Syncthing" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dark Reader" })).toBeVisible();
    expect(screen.getByText("Switched Off")).toBeVisible();
  });

  it("pins and unpins icons, but not a switched-off extension", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls, unpinned: new Set(["status-notifier:syncthing"]) });
    await openMenu();

    await userEvent.click(
      screen.getByRole("button", { name: "Pin Syncthing" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Unpin Dark Reader" }),
    );

    expect(calls).toStrictEqual([
      ["onPin", "status-notifier:syncthing"],
      ["onUnpin", `extension:${DARK}`],
    ]);
    expect(
      screen.queryByRole("button", { name: /Pin Switched Off/u }),
    ).not.toBeInTheDocument();
  });

  it("clicks an app or extension from its row, as its icon would", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls });
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: "Syncthing" }));
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: "Dark Reader" }));

    expect(calls).toStrictEqual([
      ["tray.activate", "syncthing", "primary"],
      ["onActivate", DARK],
      ["extensions.activate", DARK],
      ["onOpen", { id: DARK, popup: darkAction.popup, profile: "default" }],
    ]);
  });

  it("sends an app's right click anywhere on its row, as its icon would", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls });
    await openMenu();

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: "Syncthing" }),
    });

    expect(calls).toStrictEqual([["tray.activate", "syncthing", "context"]]);
  });

  it("opens an app's own menu from its row, and clicks the entry chosen", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls });
    await openMenu();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Network" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open" }),
    );

    expect(calls).toStrictEqual([["menu.click", 1]]);
  });

  it("switches an extension off", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls });
    await openMenu();

    await userEvent.click(screen.getByRole("switch", { name: "Dark Reader" }));

    expect(calls).toStrictEqual([["extensions.setEnabled", DARK, false]]);
  });

  it("switches the extensions of the last focused page's profile", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls, profile: work });
    await openMenu();

    expect(screen.getByText("Extensions in Work")).toBeVisible();
    const dark = screen.getByRole("switch", { name: "Dark Reader" });
    expect(dark).not.toBeChecked();
    const locked = screen.getByRole("switch", { name: "Switched Off" });
    expect(locked).toBeChecked();
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(dark);

    expect(calls).toStrictEqual([
      ["browser.setExtensionEnabled", "work", DARK, true],
    ]);
  });

  it("says when the engine refuses a change", async () => {
    renderMenu({ refuse: true });
    await openMenu();

    await userEvent.click(screen.getByRole("switch", { name: "Dark Reader" }));

    expect(
      await screen.findByText("Couldn't switch Dark Reader off"),
    ).toBeVisible();
  });

  it("opens Settings from its footer", async () => {
    const calls: unknown[][] = [];
    renderMenu({ calls });
    await openMenu();

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(calls).toStrictEqual([["onSettings"]]);
  });

  describe("an extension's ⋯ menu", () => {
    const more = async (calls: unknown[][]) => {
      renderMenu({ calls });
      await openMenu();
      await userEvent.click(
        screen.getByRole("button", { name: "More for Dark Reader" }),
      );
      return screen.findByRole("menu", { name: "More for Dark Reader" });
    };

    it("opens its options page in a browser window", async () => {
      const calls: unknown[][] = [];
      const menu = await more(calls);

      await userEvent.click(
        within(menu).getByRole("menuitem", { name: "Options" }),
      );

      expect(calls).toStrictEqual([["browser.open", darkReader.optionsUrl]]);
    });

    it("changes a setting", async () => {
      const calls: unknown[][] = [];
      renderMenu({
        calls,
        installed: [{ ...darkReader, configured: [] }, switchedOff],
      });
      await openMenu();
      await userEvent.click(
        screen.getByRole("button", { name: "More for Dark Reader" }),
      );
      const menu = await screen.findByRole("menu", {
        name: "More for Dark Reader",
      });

      await userEvent.click(
        within(menu).getByRole("menuitemcheckbox", {
          name: "Allow on local files",
        }),
      );

      expect(calls).toStrictEqual([
        ["extensions.configure", DARK, { fileAccess: false }],
      ]);
    });

    it("locks what the config sets, and says so", async () => {
      const menu = await more([]);

      const local = within(menu).getByRole("menuitemcheckbox", {
        name: /Allow on local files/u,
      });
      expect(local).toHaveAttribute("aria-disabled", "true");
      expect(local).toHaveAttribute("title", "Set in your config");
    });

    it("asks before uninstalling", async () => {
      const calls: unknown[][] = [];
      const menu = await more(calls);

      await userEvent.click(
        within(menu).getByRole("menuitem", { name: "Uninstall…" }),
      );
      expect(calls).toStrictEqual([]);
      await userEvent.click(
        await screen.findByRole("button", { name: "Uninstall" }),
      );

      expect(calls).toStrictEqual([["extensions.uninstall", DARK]]);
    });
  });
});
