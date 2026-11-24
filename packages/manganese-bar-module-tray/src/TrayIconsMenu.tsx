import { Button } from "@domicile-desktop/component-library/Button";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { List, ListRow } from "@domicile-desktop/component-library/ListRow";
import { Menu } from "@domicile-desktop/component-library/Menu";
import { Panel } from "@domicile-desktop/component-library/Panel";
import { PanelFooter } from "@domicile-desktop/component-library/PanelFooter";
import { PanelNote } from "@domicile-desktop/component-library/PanelNote";
import { PanelSection } from "@domicile-desktop/component-library/PanelSection";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { Switch } from "@domicile-desktop/component-library/Switch";
import type { watchMenu } from "@domicile-desktop/sdk/dbusmenu";
import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  Extension,
  ExtensionPopup,
  ExtensionSettings,
  InstalledExtension,
} from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/ssr/DotsThree";
import { LockIcon } from "@phosphor-icons/react/dist/ssr/Lock";
import { PushPinIcon } from "@phosphor-icons/react/dist/ssr/PushPin";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/ssr/PuzzlePiece";
import type { ReactNode } from "react";
import { useState } from "react";

import { css } from "../styled-system/css";
import { center } from "../styled-system/patterns";
import type { MenuIcons } from "./menu-icons";
import { extensionKey, statusNotifierKey } from "./tray-entry";
import { useItemMenu } from "./useItemMenu";

/** What a locked setting says while the pointer rests on it. */
const SET_IN_CONFIG = "Set in your config";

type Props = {
  /** Where clicks and changes are sent. */
  domicile: Domicile;
  /** The extensions with an action, for their popups and badges. */
  extensions: readonly Extension[];
  /** Every installed extension, switched on or off. */
  installed: readonly InstalledExtension[];
  /** The applications' icons. */
  items: readonly TrayItem[];
  /** Extension `id`'s action was clicked, from its row. */
  onActivate: (id: string) => void;
  /** Open an extension's popup. */
  onOpen: (popup: ExtensionPopup) => void;
  /** Put icon `key` back in the tray. */
  onPin: (key: string) => void;
  /** Open the Settings app. */
  onSettings: () => void;
  /** Keep icon `key` out of the tray. */
  onUnpin: (key: string) => void;
  /**
   * The last focused page's browser profile, whose switches the menu shows;
   * `undefined` before the engine lists profiles.
   */
  profile: BrowserProfile | undefined;
  /** The keys of the icons kept out of the tray. */
  unpinned: ReadonlySet<string>;
  /** Injectable so tests can answer for the applications' menus. */
  watch?: typeof watchMenu | undefined;
  /** Injectable so tests can answer for the menus' icons. */
  icons?: MenuIcons | undefined;
};

/**
 * The button at the end of the tray, and its menu of every tray icon:
 * applications' and every installed extension, each pinned to the tray or
 * not. Extensions also switch on and off in the last focused page's browser
 * profile, and their `⋯` menu holds their options, what they can read, and
 * uninstalling.
 *
 * Clicking a row does what clicking its icon does. An unpinned extension's
 * popup opens from the tray, where its icon shows while it is open.
 */
export const TrayIconsMenu = ({
  domicile,
  extensions,
  icons,
  installed,
  items,
  onActivate,
  onOpen,
  onPin,
  onSettings,
  onUnpin,
  profile,
  unpinned,
  watch,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const actions = new Map(extensions.map((action) => [action.id, action]));
  /** Runs `request`, saying `what` failed if it is refused. */
  const ask = (what: string, request: Promise<void>) => {
    request.then(
      () => {
        setFailure(undefined);
      },
      (error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: the panel says it in words; this keeps the error itself
        console.error(`tray: couldn't ${what}`, error);
        setFailure({
          detail: error instanceof Error ? error.message : String(error),
          what,
        });
      },
    );
  };
  const pinOf = (key: string, name: string) =>
    unpinned.has(key) ? (
      <IconButton
        label={`Pin ${name}`}
        onClick={() => {
          onPin(key);
        }}
        size="sm"
      >
        <PushPinIcon />
      </IconButton>
    ) : (
      <IconButton
        label={`Unpin ${name}`}
        onClick={() => {
          onUnpin(key);
        }}
        size="sm"
      >
        <PushPinIcon weight="fill" />
      </IconButton>
    );
  return (
    <Popover
      align="end"
      onOpenChange={setOpen}
      open={open}
      side="bottom"
      tone="overPhoto"
      trigger={
        <Button label="All tray icons" size="sm" variant="ghost">
          <span className={caretStyles}>
            <CaretDownIcon aria-hidden size={12} weight="bold" />
          </span>
        </Button>
      }
    >
      <Panel title="Tray icons" width="standard">
        {failure !== undefined && (
          <PanelNote detail={failure.detail} tone="warning">
            {`Couldn't ${failure.what}`}
          </PanelNote>
        )}
        {items.length === 0 && installed.length === 0 && (
          <EmptyState
            hint="Apps and extensions with an icon show up here."
            icon={PuzzlePieceIcon}
            title="Nothing in the tray"
          />
        )}
        {items.length > 0 && (
          <PanelSection label="Apps">
            <List>
              {items.map((item) => (
                <AppRow
                  domicile={domicile}
                  icons={icons}
                  item={item}
                  key={item.id}
                  onClose={() => {
                    setOpen(false);
                  }}
                  pin={pinOf(statusNotifierKey(item.id), item.title)}
                  watch={watch}
                />
              ))}
            </List>
          </PanelSection>
        )}
        {installed.length > 0 && (
          <PanelSection
            label={
              profile === undefined
                ? "Extensions"
                : `Extensions in ${profile.name}`
            }
          >
            <List>
              {installed.map((extension) => (
                <ExtensionRow
                  action={actions.get(extension.id)}
                  ask={ask}
                  domicile={domicile}
                  extension={extension}
                  key={extension.id}
                  locked={
                    profile?.lockedExtensions.includes(extension.id) ?? false
                  }
                  on={
                    profile === undefined
                      ? extension.enabled
                      : profile.enabledExtensions.includes(extension.id)
                  }
                  onActivate={(action) => {
                    setOpen(false);
                    onActivate(action.id);
                    domicile.extensions.activate(action.id);
                    if (action.popup !== undefined) {
                      onOpen({
                        id: action.id,
                        popup: action.popup,
                        profile: action.profile,
                      });
                    }
                  }}
                  onSettings={onSettings}
                  onSwitch={(on) => {
                    ask(
                      profile === undefined
                        ? `switch ${extension.name} ${on ? "on" : "off"}`
                        : `switch ${extension.name} ${on ? "on" : "off"} in ${profile.name}`,
                      profile === undefined
                        ? domicile.extensions.setEnabled(extension.id, on)
                        : domicile.browser.setExtensionEnabled(
                            profile.id,
                            extension.id,
                            on,
                          ),
                    );
                  }}
                  pin={pinOf(extensionKey(extension.id), extension.name)}
                />
              ))}
            </List>
          </PanelSection>
        )}
        <PanelFooter
          action={
            <Button
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
              rounded
              size="xs"
              variant="ghost"
            >
              Settings
            </Button>
          }
        />
      </Panel>
    </Popover>
  );
};

/** A request the engine refused: what it was, and the engine's words. */
type Failure = { detail: string; what: string };

type AppRowProps = Pick<Props, "icons" | "watch"> & {
  domicile: Domicile;
  item: TrayItem;
  /** Closes the tray's menu. */
  onClose: () => void;
  /** Its pin button. */
  pin: ReactNode;
};

/**
 * An application's row. A click is its icon's primary click; a right click
 * anywhere on it opens its own menu there.
 */
const AppRow = ({
  domicile,
  icons,
  item,
  onClose,
  pin,
  watch,
}: AppRowProps) => {
  const menu = useItemMenu(domicile, item, watch, icons);
  return (
    <ListRow
      // The menu beside the row's button, so its clicks don't bubble into it.
      actions={
        <>
          {pin}
          {menu.opened}
        </>
      }
      icon={
        item.icon === undefined ? (
          <span className={letterStyles}>{item.title.slice(0, 1)}</span>
        ) : (
          <img alt="" className={iconStyles} src={item.icon} />
        )
      }
      label={item.title}
      onPress={() => {
        onClose();
        domicile.tray.activate(item.id, "primary");
      }}
      onSecondaryPress={menu.show}
    />
  );
};

type ExtensionRowProps = {
  /** Its action, while it has one in the tray. */
  action: Extension | undefined;
  /** Runs a request, saying what failed if it is refused. */
  ask: (what: string, request: Promise<void>) => void;
  domicile: Domicile;
  extension: InstalledExtension;
  /** Whether it is on in the profile the menu shows. */
  on: boolean;
  /** The config switches it in that profile, so the menu cannot. */
  locked: boolean;
  /** Its row was clicked: click `action`. */
  onActivate: (action: Extension) => void;
  /** Open the Settings app. */
  onSettings: () => void;
  /** Switch it on or off in the profile the menu shows. */
  onSwitch: (on: boolean) => void;
  /** Its pin button. */
  pin: ReactNode;
};

/**
 * An installed extension's row: its pin while it is on, its switch, and its
 * `⋯` menu. Its icon is its manifest's, so it shows while it is off.
 */
const ExtensionRow = ({
  action,
  ask,
  domicile,
  extension,
  locked,
  on,
  onActivate,
  onSettings,
  onSwitch,
  pin,
}: ExtensionRowProps) => {
  const [uninstalling, setUninstalling] = useState(false);
  const { id, name } = extension;
  const enabled = on;
  const controls = (
    <>
      {enabled && pin}
      {locked && lockIcon}
      <Switch
        checked={enabled}
        disabled={locked}
        hideLabel
        label={name}
        onCheckedChange={onSwitch}
      />
      <ExtensionMore
        ask={ask}
        domicile={domicile}
        extension={extension}
        onSettings={onSettings}
        onUninstall={() => {
          setUninstalling(true);
        }}
      />
    </>
  );
  const icon = <img alt="" className={iconStyles} src={extension.icon} />;
  const confirm = uninstalling && (
    <div className={confirmStyles}>
      <span>{`Uninstall ${name}?`}</span>
      <span className={confirmButtonsStyles}>
        <Button
          onClick={() => {
            setUninstalling(false);
          }}
          rounded
          size="xs"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            setUninstalling(false);
            ask(`uninstall ${name}`, domicile.extensions.uninstall(id));
          }}
          rounded
          size="xs"
          variant="danger"
        >
          Uninstall
        </Button>
      </span>
    </div>
  );
  return action === undefined ? (
    <ListRow
      detail={enabled ? undefined : "Off"}
      end={controls}
      icon={icon}
      label={name}
    >
      {confirm}
    </ListRow>
  ) : (
    <ListRow
      actions={controls}
      icon={icon}
      label={name}
      onPress={() => {
        onActivate(action);
      }}
    >
      {confirm}
    </ListRow>
  );
};

type ExtensionMoreProps = {
  ask: (what: string, request: Promise<void>) => void;
  domicile: Domicile;
  extension: InstalledExtension;
  onSettings: () => void;
  /** Uninstall… was chosen: ask first. */
  onUninstall: () => void;
};

/**
 * An extension's `⋯` menu: its options page, what it can read, and the
 * settings it can use. What the desk's config sets is locked, with a lock and
 * a word on why.
 */
const ExtensionMore = ({
  ask,
  domicile,
  extension,
  onSettings,
  onUninstall,
}: ExtensionMoreProps) => {
  const {
    configured,
    fileAccess,
    fromConfig,
    id,
    name,
    optionsUrl,
    siteAccess,
    userScripts,
  } = extension;
  const configure = (settings: ExtensionSettings) => {
    ask(`change ${name}`, domicile.extensions.configure(id, settings));
  };
  const locked = (setting: InstalledExtension["configured"][number]) =>
    configured.includes(setting);
  const lock = (setting: InstalledExtension["configured"][number]) =>
    locked(setting)
      ? { disabled: true, icon: lockIcon, title: SET_IN_CONFIG }
      : {};
  return (
    <Menu
      trigger={
        <IconButton label={`More for ${name}`} size="sm">
          <DotsThreeIcon weight="bold" />
        </IconButton>
      }
    >
      {optionsUrl !== undefined && (
        <Menu.Item
          onClick={() => {
            domicile.browser.open(optionsUrl);
          }}
        >
          Options
        </Menu.Item>
      )}
      {siteAccess !== undefined && (
        <Menu.Submenu
          disabled={locked("siteAccess")}
          icon={locked("siteAccess") ? lockIcon : undefined}
          label="Can read websites"
        >
          <Menu.RadioGroup
            onValueChange={(chosen: string) => {
              if (chosen === "specific_sites") {
                onSettings();
              } else if (chosen === "on_click" || chosen === "all_sites") {
                configure({ siteAccess: chosen });
              } else {
                throw new Error(`tray: no site access ${chosen}`);
              }
            }}
            value={siteAccess}
          >
            <Menu.RadioItem value="on_click">
              Only when you click it
            </Menu.RadioItem>
            <Menu.RadioItem value="all_sites">On all sites</Menu.RadioItem>
            <Menu.RadioItem value="specific_sites">
              On sites you choose…
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Submenu>
      )}
      {fileAccess !== undefined && (
        <Menu.CheckboxItem
          checked={fileAccess}
          onCheckedChange={(checked) => {
            configure({ fileAccess: checked });
          }}
          {...lock("fileAccess")}
        >
          Allow on local files
        </Menu.CheckboxItem>
      )}
      {userScripts !== undefined && (
        <Menu.CheckboxItem
          checked={userScripts}
          onCheckedChange={(checked) => {
            configure({ userScripts: checked });
          }}
          {...lock("userScripts")}
        >
          Allow user scripts
        </Menu.CheckboxItem>
      )}
      {!fromConfig && (
        <>
          <Menu.Separator />
          <Menu.Item onClick={onUninstall}>Uninstall…</Menu.Item>
        </>
      )}
    </Menu>
  );
};

/** Marks a setting the desk's config sets. */
const lockIcon = <LockIcon aria-label={SET_IN_CONFIG} role="img" />;

// Chrome's 16px toolbar icon size, as the tray's icons.
const iconStyles = css({ blockSize: 4, inlineSize: 4, objectFit: "contain" });

// The same box as an icon, for an application without one.
const letterStyles = center({
  blockSize: 4,
  fontSize: "ui",
  inlineSize: 4,
});

// The caret, in the box of a tray icon.
const caretStyles = center({ blockSize: 4, inlineSize: 4 });

const confirmStyles = css({
  alignItems: "center",
  display: "flex",
  gap: 2,
  justifyContent: "space-between",
  textStyle: "panelDetail",
});

const confirmButtonsStyles = css({ display: "flex", gap: 1 });
