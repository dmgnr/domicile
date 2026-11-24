import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { Select } from "@domicile-desktop/component-library/Select";
import { Switch } from "@domicile-desktop/component-library/Switch";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { GearIcon } from "@phosphor-icons/react/dist/ssr/Gear";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import { useId, useState } from "react";

import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { AddRow } from "../AddRow";
import type { ConfigEditor, Report } from "../config-editor";
import { ExtensionIcon } from "../ExtensionIcon";
import type { Extensions } from "../extensions";
import type {
  ExtensionSettings,
  InstalledExtension,
  SettingsHost,
} from "../host";
import { ListSetting } from "../ListSetting";
import { Notice } from "../Notice";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { isSite } from "../sites";
import { useInstalled } from "../useInstalled";

type Props = {
  title: string;
  description: string;
  /** The config, which installs and uninstalls; none when unreadable. */
  editor: ConfigEditor | undefined;
  /** Why the config cannot change, or `undefined` if it can. */
  readOnly: string | undefined;
  extensions: Extensions;
  host: SettingsHost;
  report: Report;
};

/**
 * The extensions in browser windows: switched on and off and configured
 * through the browser. The config's are installed and uninstalled through the
 * config; unpacked folders load, and others uninstall, through the engine.
 * A setting the config sets changes in the config, and the rest through the
 * engine.
 */
export const ExtensionsPage = ({
  description,
  editor,
  extensions,
  host,
  readOnly,
  report,
  title,
}: Props) => {
  const { failure, listed, reload } = useInstalled(extensions, host);
  const fromStore = editor?.settings.extensions.web_store ?? [];
  const configurable = editor !== undefined && readOnly === undefined;
  const store = configurable
    ? {
        ids: fromStore,
        keep: (left: string[]) => {
          editor.set(
            ["extensions", "web_store"],
            left.length === 0 ? undefined : left,
          );
        },
      }
    : undefined;
  return (
    <Page description={description} readOnly={readOnly} title={title}>
      <Card title="Installed">
        {failure !== undefined && (
          <Notice tone="danger">
            Couldn't list extensions:{" "}
            {failure instanceof Error ? failure.message : String(failure)}
          </Notice>
        )}
        <ul className={listStyles}>
          {listed?.installed.map((extension) => (
            <ExtensionRow
              configurable={configurable}
              configured={
                editor?.settings.extensions.settings[extension.id] ?? {}
              }
              extension={extension}
              key={extension.id}
              onConfigure={(settings) => {
                configure({
                  configurable,
                  configured:
                    editor?.settings.extensions.settings[extension.id] ?? {},
                  editor,
                  extension,
                  extensions,
                  reload,
                  report,
                  settings,
                });
              }}
              onEnabled={(enabled) => {
                extensions
                  .setEnabled(extension.id, enabled)
                  .then(reload, report(`Couldn't switch ${extension.name}`));
              }}
              onOptions={(url) => {
                extensions
                  .openOptions(url)
                  .catch(report(`Couldn't open ${extension.name}'s options`));
              }}
              onUninstall={uninstaller({
                extension,
                fromConfig: listed.fromConfig,
                onUninstalled: reload,
                report,
                store,
                uninstall: host.uninstallExtension,
              })}
              report={report}
            />
          ))}
        </ul>
      </Card>
      <Card title="Load an unpacked folder">
        <p className={hintStyles}>
          Loads the extension in a folder on this computer, with every
          permission it asks for. It stays until you uninstall it.
        </p>
        <div>
          <Button
            beforeIcon={<FolderOpenIcon size={14} />}
            onClick={() => {
              host
                .chooseFolder()
                .then(async (directory) => {
                  if (directory !== undefined) {
                    await host.loadUnpacked(directory);
                    reload();
                  }
                })
                .catch(report("Couldn't load the folder"));
            }}
            size="sm"
            variant="primary"
          >
            Load unpacked folder
          </Button>
        </div>
      </Card>
      {editor !== undefined && (
        <>
          <Card title="Unpacked folders in the config">
            <p className={hintStyles}>
              Folders the config loads on every start: an absolute path, or one
              under ~.
            </p>
            <ListSetting
              addButton="Add folder"
              addLabel="Add a folder"
              disabled={!configurable}
              items={editor.settings.extensions.unpacked}
              onChange={(unpacked) => {
                editor.set(
                  ["extensions", "unpacked"],
                  unpacked.length === 0 ? undefined : unpacked,
                );
              }}
              placeholder="~/src/my-extension"
            />
          </Card>
        </>
      )}
    </Page>
  );
};

type UninstallerOptions = {
  extension: InstalledExtension;
  /**
   * The config's Web Store ids and how to keep only some, or `undefined` when
   * the config cannot change.
   */
  store: { ids: string[]; keep: (left: string[]) => void } | undefined;
  /** Every id the config installed. */
  fromConfig: string[];
  uninstall: SettingsHost["uninstallExtension"];
  onUninstalled: () => void;
  report: Report;
};

/**
 * How to uninstall `extension`: through the config if it lists it, else
 * through the engine. `undefined` if only a config that cannot change could
 * remove it, since the engine installs the config's again.
 */
const uninstaller = ({
  extension,
  fromConfig,
  onUninstalled,
  report,
  store,
  uninstall,
}: UninstallerOptions): (() => void) | undefined => {
  if (store?.ids.includes(extension.id) === true) {
    return () => {
      store.keep(store.ids.filter((id) => id !== extension.id));
    };
  } else if (fromConfig.includes(extension.id)) {
    return undefined;
  } else {
    return () => {
      uninstall(extension.id).then(
        onUninstalled,
        report(`Couldn't uninstall ${extension.name}`),
      );
    };
  }
};

/** Every setting an extension may have. */
const SETTINGS = [
  "file_access",
  "user_scripts",
  "site_access",
] as const satisfies (keyof ExtensionSettings)[];

type ConfigureOptions = {
  extension: InstalledExtension;
  /** The changes. */
  settings: ExtensionSettings;
  /** What the config sets for `extension`. */
  configured: ExtensionSettings;
  editor: ConfigEditor | undefined;
  configurable: boolean;
  extensions: Extensions;
  reload: () => void;
  report: Report;
};

/**
 * Changes `extension`'s `settings`: in the config for each it sets, through
 * the engine for the rest. One a config that cannot change sets is locked, so
 * it never gets here.
 */
const configure = ({
  configurable,
  configured,
  editor,
  extension,
  extensions,
  reload,
  report,
  settings,
}: ConfigureOptions) => {
  const keys = SETTINGS.filter((key) => settings[key] !== undefined);
  const inConfig = keys.filter((key) => configured[key] !== undefined);
  const inEngine = keys.filter((key) => configured[key] === undefined);
  if (inConfig.length > 0) {
    if (editor === undefined || !configurable) {
      throw new Error(
        `${extension.name}'s ${inConfig.join(", ")} is the config's, which cannot change`,
      );
    }
    for (const key of inConfig) {
      editor.set(["extensions", "settings", extension.id, key], settings[key]);
    }
  }
  if (inEngine.length > 0) {
    extensions
      .configure(
        extension.id,
        Object.fromEntries(inEngine.map((key) => [key, settings[key]])),
      )
      .then(reload, report(`Couldn't change ${extension.name}'s settings`));
  }
};

type ExtensionRowProps = {
  extension: InstalledExtension;
  /** What the config sets for it, which shows over what the engine says. */
  configured: ExtensionSettings;
  /** Whether the config can change. */
  configurable: boolean;
  onEnabled: (enabled: boolean) => void;
  onConfigure: (settings: ExtensionSettings) => void;
  onOptions: (url: string) => void;
  /** Uninstalls it, or `undefined` if the page cannot. */
  onUninstall: (() => void) | undefined;
  report: Report;
};

/**
 * One extension: its switch, the settings it can use while it is on, and its
 * options and uninstall buttons.
 */
const ExtensionRow = ({
  configurable,
  configured,
  extension,
  onConfigure,
  onEnabled,
  onOptions,
  onUninstall,
  report,
}: ExtensionRowProps) => {
  const { description, enabled, icon, name, optionsUrl, version } = extension;
  // The config's, where it sets one, over the engine's.
  const settings = {
    ...extension.settings,
    ...Object.fromEntries(
      Object.entries(configured).filter(([, value]) => value !== undefined),
    ),
  };
  /** Whether the page cannot change `key`: a config that cannot change sets it. */
  const locked = (key: keyof ExtensionSettings) =>
    !configurable && configured[key] !== undefined;
  const nameId = useId();
  return (
    <li className={rowStyles}>
      <div aria-labelledby={nameId} className={groupStyles} role="group">
        <div className={headStyles}>
          <ExtensionIcon icon={icon} name={name} size="md" />
          <div className={textStyles}>
            <span className={nameStyles}>
              <span id={nameId}>{name}</span>{" "}
              <span className={versionStyles}>{version}</span>
            </span>
            {description !== "" && (
              <span className={descriptionStyles}>{description}</span>
            )}
          </div>
          <Switch
            aria-labelledby={nameId}
            checked={enabled}
            label={enabled ? "On" : "Off"}
            onCheckedChange={onEnabled}
          />
        </div>
        <div className={bodyStyles}>
          {enabled && settings.site_access !== undefined && (
            <SiteAccessSetting
              disabled={locked("site_access")}
              onChange={(siteAccess) => {
                onConfigure({ site_access: siteAccess });
              }}
              report={report}
              value={settings.site_access}
            />
          )}
          {enabled && settings.file_access !== undefined && (
            <SettingRow title="Allow on local files">
              <Switch
                checked={settings.file_access}
                disabled={locked("file_access")}
                hideLabel
                label="Allow on local files"
                onCheckedChange={(allowed) => {
                  onConfigure({ file_access: allowed });
                }}
              />
            </SettingRow>
          )}
          {enabled && settings.user_scripts !== undefined && (
            <SettingRow
              hint="Lets it run scripts you add to it"
              title="Allow user scripts"
            >
              <Switch
                checked={settings.user_scripts}
                disabled={locked("user_scripts")}
                hideLabel
                label="Allow user scripts"
                onCheckedChange={(allowed) => {
                  onConfigure({ user_scripts: allowed });
                }}
              />
            </SettingRow>
          )}
          {(optionsUrl !== undefined || onUninstall !== undefined) && (
            <div className={actionsStyles}>
              {optionsUrl !== undefined && (
                <Button
                  beforeIcon={<GearIcon size={14} />}
                  onClick={() => {
                    onOptions(optionsUrl);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Options
                </Button>
              )}
              {onUninstall !== undefined && (
                <Button
                  beforeIcon={<TrashIcon size={14} />}
                  onClick={onUninstall}
                  size="sm"
                  variant="dangerGhost"
                >
                  Uninstall
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

/** The value the site access menu shows for a list of sites. */
const SPECIFIC = "specific";

const SITE_ACCESS = [
  { label: "When you click it", value: "on_click" },
  { label: "On specific sites", value: SPECIFIC },
  { label: "On all sites", value: "all_sites" },
] as const;

type SiteAccess = NonNullable<ExtensionSettings["site_access"]>;

type SiteAccessProps = {
  value: SiteAccess;
  disabled: boolean;
  onChange: (value: SiteAccess) => void;
  report: Report;
};

/**
 * Which sites an extension runs on, and the sites themselves when it is
 * specific ones. Picking specific sites changes nothing until one is added:
 * an empty list is "When you click it".
 */
const SiteAccessSetting = ({
  disabled,
  onChange,
  report,
  value,
}: SiteAccessProps) => {
  const [picking, setPicking] = useState(false);
  const sites = Array.isArray(value) ? value : [];
  const specific = Array.isArray(value) || picking;
  return (
    <>
      <SettingRow title="Site access">
        <Select
          aria-label="Site access"
          disabled={disabled}
          onValueChange={(mode) => {
            switch (mode) {
              case SPECIFIC: {
                setPicking(true);
                break;
              }
              case "on_click":
              case "all_sites": {
                setPicking(false);
                onChange(mode);
                break;
              }
              default: {
                throw new Error(`No site access ${String(mode)}`);
              }
            }
          }}
          options={SITE_ACCESS}
          size="sm"
          value={specific || Array.isArray(value) ? SPECIFIC : value}
          width={44}
        />
      </SettingRow>
      {specific && (
        <div className={sitesStyles}>
          {sites.length > 0 && (
            <ul className={chipsStyles}>
              {sites.map((site, index) => (
                <li className={chipStyles} key={site}>
                  {site}
                  {!disabled && (
                    <IconButton
                      label={`Remove ${site}`}
                      onClick={() => {
                        onChange(sites.toSpliced(index, 1));
                      }}
                      size="sm"
                    >
                      <XIcon size={12} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!disabled && (
            <AddRow
              button="Add site"
              label="Add a site"
              onAdd={(typed) => {
                const site = typed.toLowerCase();
                if (!isSite(site)) {
                  report("Couldn't add the site")(
                    new Error(
                      `${typed} is not a site, such as example.com or *.example.com`,
                    ),
                  );
                } else if (!sites.includes(site)) {
                  onChange([...sites, site]);
                }
              }}
              placeholder="example.com"
            />
          )}
        </div>
      )}
    </>
  );
};

const listStyles = flex({
  direction: "column",
  gap: 0,
  listStyle: "none",
  margin: 0,
  padding: 0,
});

const rowStyles = css({
  "&:first-of-type": { borderBlockStart: "none", paddingBlockStart: 0 },
  "&:last-of-type": { paddingBlockEnd: 0 },
  borderBlockStart: "1px solid {colors.border}",
  paddingBlock: 3,
});

const groupStyles = flex({ direction: "column", gap: 2 });

const headStyles = flex({ align: "center", gap: 3 });

// Under the name, past the icon.
const bodyStyles = flex({
  _empty: { display: "none" },
  direction: "column",
  paddingInlineStart: 12,
});

const textStyles = flex({
  direction: "column",
  flexGrow: 1,
  gap: 0.5,
  minInlineSize: 0,
});

const nameStyles = css({ fontSize: "sm", fontWeight: "medium" });

const versionStyles = css({ color: "textTertiary", fontSize: "xs" });

const descriptionStyles = css({
  color: "muted",
  fontSize: "xs",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const actionsStyles = flex({
  align: "center",
  gap: 2,
  justify: "flex-end",
  paddingBlockStart: 2,
});

const sitesStyles = flex({
  direction: "column",
  gap: 2,
  paddingBlockEnd: 3,
});

const chipsStyles = flex({
  gap: 2,
  listStyle: "none",
  margin: 0,
  padding: 0,
  wrap: "wrap",
});

const chipStyles = flex({
  align: "center",
  border: "1px solid {colors.border}",
  borderRadius: "full",
  fontSize: "xs",
  gap: 1,
  paddingBlock: 0.5,
  paddingInlineEnd: 1,
  paddingInlineStart: 3,
});

const hintStyles = css({ color: "muted", fontSize: "xs", margin: 0 });
