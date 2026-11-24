import { Button } from "@domicile-desktop/component-library/Button";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { Input } from "@domicile-desktop/component-library/Input";
import { Select } from "@domicile-desktop/component-library/Select";
import { Switch } from "@domicile-desktop/component-library/Switch";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/ssr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/ssr/ArrowUp";
import { PlusIcon } from "@phosphor-icons/react/dist/ssr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import type { ReactNode } from "react";
import { useId, useState } from "react";

import { css } from "../../styled-system/css";
import { circle, flex, grid } from "../../styled-system/patterns";
import { AddRow } from "../AddRow";
import type { BrowserConfig } from "../browser-profiles";
import {
  isProfileSite,
  PROFILE_COLORS,
  withDefault,
  withExtensionSwitched,
  withNewProfile,
  withoutProfile,
  withProfileChanged,
  withProfileMoved,
  withSite,
} from "../browser-profiles";
import { ColorWell } from "../ColorWell";
import type { ConfigEditor, Report } from "../config-editor";
import { ExtensionIcon } from "../ExtensionIcon";
import type { Extensions } from "../extensions";
import type {
  BrowserProfile,
  BrowserProfiles,
  BrowserSite,
  SettingsHost,
} from "../host";
import { Notice } from "../Notice";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { useBrowserProfiles } from "../useBrowserProfiles";
import { useExtensionsById } from "../useExtensionNames";

type Props = {
  title: string;
  description: string;
  /** The config, which defines the profiles; none when unreadable. */
  editor: ConfigEditor | undefined;
  /** Why the config cannot change, or `undefined` if it can. */
  readOnly: string | undefined;
  extensions: Extensions;
  host: SettingsHost;
  report: Report;
};

/**
 * The browser profiles: a card per profile, and the sites that open outside
 * the default one. Profiles, their colors and the config's sites change in
 * the config. Extension switches and the sites the user adds are saved by the
 * desktop, under the config's: a switch or site the config sets changes only
 * in the config.
 */
export const ProfilesPage = ({
  description,
  editor,
  extensions,
  host,
  readOnly,
  report,
  title,
}: Props) => {
  const { failure, listed, reload } = useBrowserProfiles(host);
  const installed = useExtensionsById(extensions, report);
  const sitesId = useId();
  const configurable = editor !== undefined && readOnly === undefined;
  /** Writes the config's `browser` as `change` makes it, if it can change. */
  const change = configurable
    ? (next: (browser: BrowserConfig) => BrowserConfig) => {
        try {
          editor.set(["browser"], next(editor.settings.browser));
        } catch (error) {
          report("Couldn't change the profiles")(error);
        }
      }
    : undefined;
  return (
    <Page description={description} readOnly={readOnly} title={title}>
      {failure !== undefined && (
        <Notice tone="danger">
          Couldn't list the profiles:{" "}
          {failure instanceof Error ? failure.message : String(failure)}
        </Notice>
      )}
      {(listed?.profiles ?? []).map((profile, at, profiles) => (
        <ProfileCard
          change={change}
          extensionIcon={(id) => installed.get(id)?.icon}
          extensionName={(id) => installed.get(id)?.name ?? id}
          first={at === 0}
          isDefault={profile.id === listed?.defaultProfile}
          isDefaultPrivate={profile.id === listed?.defaultPrivateProfile}
          key={profile.id}
          last={at === profiles.length - 1}
          onSwitch={(extension, enabled) => {
            host
              .setExtensionEnabled(extension, enabled, profile.id)
              .then(reload, report(`Couldn't switch it in ${profile.name}`));
          }}
          profile={profile}
        />
      ))}
      {change !== undefined && (
        <div className={addProfileStyles}>
          <AddRow
            button="Add profile"
            label="New profile's name"
            onAdd={(name) => {
              change((browser) => withNewProfile(browser, name));
            }}
            placeholder="Name, like Work"
          />
        </div>
      )}
      {listed !== undefined && (
        <section aria-labelledby={sitesId} className={sitesSectionStyles}>
          <div className={sitesHeadStyles}>
            <h2 className={sitesTitleStyles} id={sitesId}>
              Sites
            </h2>
            <p className={hintStyles}>
              Each site opens in one profile. Sites not listed open in the
              default profile, so the default never needs entries.
            </p>
          </div>
          <SitesList
            change={change}
            listed={listed}
            onPin={(site, profile) => {
              host
                .pinBrowserSite(site, profile)
                .then(reload, report(`Couldn't change where ${site} opens`));
            }}
          />
        </section>
      )}
    </Page>
  );
};

type ProfileCardProps = {
  profile: BrowserProfile;
  /** First in the order, so it can't move up. */
  first: boolean;
  /** Last in the order, so it can't move down. */
  last: boolean;
  isDefault: boolean;
  isDefaultPrivate: boolean;
  /** Changes the config's `browser`, or `undefined` when it can't change. */
  change:
    | ((next: (browser: BrowserConfig) => BrowserConfig) => void)
    | undefined;
  extensionName: (id: string) => string;
  /** The extension's icon, or none when it has none. */
  extensionIcon: (id: string) => string | undefined;
  /** Switches an extension the config doesn't lock. */
  onSwitch: (extension: string, enabled: boolean) => void;
};

/** One profile: its color, whether it is private, and its extensions. */
const ProfileCard = ({
  change,
  extensionIcon,
  extensionName,
  first,
  isDefault,
  isDefaultPrivate,
  last,
  onSwitch,
  profile,
}: ProfileCardProps) => {
  const nameId = useId();
  const profileColor = profile.color.toLowerCase();
  // Picked from the swatches, else from the well, which then shows it.
  const swatched = PROFILE_COLORS.some((color) => color === profileColor);
  const on = profile.extensions
    .filter(({ enabled }) => enabled)
    .map(({ id }) => id);
  return (
    <section aria-labelledby={nameId} className={cardStyles}>
      <div className={cardHeadStyles}>
        <span
          aria-hidden
          className={dotStyles}
          style={{ backgroundColor: profile.color }}
        />
        <h2 className={cardNameStyles} id={nameId}>
          {profile.name}
        </h2>
        {isDefault && <span className={badgeStyles}>Default</span>}
        {isDefaultPrivate && (
          <span className={badgeStyles}>Default private</span>
        )}
        {change !== undefined && (
          <span className={cardActionsStyles}>
            <IconButton
              disabled={first}
              label={`Move ${profile.name} up`}
              onClick={() => {
                change((browser) => withProfileMoved(browser, profile.id, -1));
              }}
              size="sm"
            >
              <ArrowUpIcon size={14} />
            </IconButton>
            <IconButton
              disabled={last}
              label={`Move ${profile.name} down`}
              onClick={() => {
                change((browser) => withProfileMoved(browser, profile.id, 1));
              }}
              size="sm"
            >
              <ArrowDownIcon size={14} />
            </IconButton>
            {!isDefault && !isDefaultPrivate && (
              <Button
                onClick={() => {
                  change((browser) => withDefault(browser, profile.id));
                }}
                size="sm"
                variant="ghost"
              >
                Make default
              </Button>
            )}
            {!isDefault && !isDefaultPrivate && (
              <IconButton
                label={`Remove ${profile.name}`}
                onClick={() => {
                  change((browser) => withoutProfile(browser, profile.id));
                }}
                size="sm"
              >
                <TrashIcon size={14} />
              </IconButton>
            )}
          </span>
        )}
      </div>
      <div className={cardBodyStyles}>
        <SettingRow title="Color">
          <div
            aria-label={`${profile.name}'s color`}
            className={swatchesStyles}
            role="radiogroup"
          >
            {PROFILE_COLORS.map((color) => (
              <button
                aria-checked={color === profileColor}
                aria-label={color}
                className={swatchStyles}
                disabled={change === undefined}
                key={color}
                onClick={() => {
                  change?.((browser) =>
                    withProfileChanged(browser, profile.id, { color }),
                  );
                }}
                role="radio"
                style={{ backgroundColor: color }}
                type="button"
              />
            ))}
            <ColorWell
              disabled={change === undefined}
              label={`${profile.name}'s color, any color`}
              onCommit={(color) => {
                change?.((browser) =>
                  withProfileChanged(browser, profile.id, { color }),
                );
              }}
              rainbow={swatched}
              shape="round"
              value={profile.color}
            />
          </div>
        </SettingRow>
        <SettingRow
          hint="Keeps no history, sign-ins or site data after its last page closes."
          title="Private"
        >
          <Switch
            checked={profile.private}
            // The default profile keeps sign-ins; the default private one
            // never does.
            disabled={change === undefined || isDefault || isDefaultPrivate}
            hideLabel
            label={`${profile.name} is private`}
            onCheckedChange={(isPrivate) => {
              change?.((browser) =>
                withProfileChanged(browser, profile.id, { private: isPrivate }),
              );
            }}
          />
        </SettingRow>
        <div className={extensionsRowStyles}>
          <span className={rowTitleStyles}>Extensions</span>
          {profile.extensions.length === 0 ? (
            <EmptyState layout="inline" title="No extensions yet" />
          ) : (
            <ul className={extensionListStyles}>
              {profile.extensions.map(({ enabled, id, locked }) => {
                const name = extensionName(id);
                return (
                  <li className={extensionStyles} key={id}>
                    <ExtensionIcon
                      icon={extensionIcon(id)}
                      name={name}
                      size="sm"
                    />
                    <span className={extensionNameStyles}>{name}</span>
                    <Switch
                      checked={enabled}
                      disabled={locked && change === undefined}
                      hideLabel
                      label={`${name} in ${profile.name}`}
                      onCheckedChange={(switched) => {
                        if (locked) {
                          change?.((browser) =>
                            withExtensionSwitched(
                              browser,
                              profile.id,
                              id,
                              switched,
                              on,
                            ),
                          );
                        } else {
                          onSwitch(id, switched);
                        }
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};

type SitesListProps = {
  listed: BrowserProfiles;
  change:
    | ((next: (browser: BrowserConfig) => BrowserConfig) => void)
    | undefined;
  /** Opens `site` in `profile`, saved by the desktop. */
  onPin: (site: string, profile: string) => void;
};

/**
 * The sites that open outside the default profile, one row each, and a row
 * that adds one. A site the config lists changes in the config; the rest are
 * the desktop's.
 */
const SitesList = ({ change, listed, onPin }: SitesListProps) => {
  const choices = listed.profiles
    .filter(({ id }) => id !== listed.defaultProfile)
    .map((profile) => ({
      label: <ProfileChoice profile={profile} />,
      textLabel: profile.name,
      value: profile.id,
    }));
  const sites = listed.sites.toSorted((a, b) => a.site.localeCompare(b.site));
  const move = (site: BrowserSite, profile: string) => {
    if (site.pinned) {
      onPin(site.site, profile);
    } else {
      change?.((browser) => withSite(browser, site.site, profile));
    }
  };
  return (
    <div className={sitesCardStyles}>
      <ul className={sitesListStyles}>
        {sites.map((site) => {
          const locked = !site.pinned && change === undefined;
          return (
            <li className={siteRowStyles} key={site.site}>
              <span className={siteStyles}>{site.site}</span>
              <Select
                aria-label={`Where ${site.site} opens`}
                disabled={locked}
                onValueChange={(profile) => {
                  if (profile !== null) {
                    move(site, profile);
                  }
                }}
                options={choices}
                size="sm"
                value={site.profile}
                width={40}
              />
              {locked ? (
                <span className={removeSpaceStyles} />
              ) : (
                <IconButton
                  label={`Remove ${site.site}`}
                  onClick={() => {
                    move(site, listed.defaultProfile);
                  }}
                  size="sm"
                >
                  <XIcon size={14} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      {choices.length > 0 && (
        <AddSite
          choices={choices}
          listed={listed}
          onAdd={(site, profile) => {
            onPin(site, profile);
          }}
        />
      )}
    </div>
  );
};

type Choice = { label: ReactNode; textLabel: string; value: string };

type AddSiteProps = {
  listed: BrowserProfiles;
  choices: Choice[];
  onAdd: (site: string, profile: string) => void;
};

/**
 * A site and the profile to open it in. A site already listed is refused,
 * pointing at its row.
 */
const AddSite = ({ choices, listed, onAdd }: AddSiteProps) => {
  const [typed, setTyped] = useState("");
  const [profile, setProfile] = useState(choices[0]?.value ?? "");
  const site = typed.trim().toLowerCase().replace(/\/+$/, "");
  const existing = listed.sites.find((listedSite) => listedSite.site === site);
  const invalid = site !== "" && !isProfileSite(site);
  const add = () => {
    if (site !== "" && existing === undefined && !invalid) {
      onAdd(site, profile);
      setTyped("");
    }
  };
  const nameOf = (id: string) =>
    listed.profiles.find((each) => each.id === id)?.name ?? id;
  return (
    <div className={addSiteStyles}>
      <div className={siteRowStyles}>
        <Input
          aria-label="Add a site"
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              add();
            }
          }}
          placeholder="Add a site, like example.com"
          size="sm"
          value={typed}
        />
        <Select
          aria-label="Profile to open it in"
          onValueChange={(chosen) => {
            if (chosen !== null) {
              setProfile(chosen);
            }
          }}
          options={choices}
          size="sm"
          value={profile}
          width={40}
        />
        <Button
          beforeIcon={<PlusIcon size={14} />}
          disabled={site === "" || existing !== undefined || invalid}
          onClick={add}
          size="sm"
          variant="outline"
        >
          Add
        </Button>
      </div>
      {existing !== undefined && (
        <p className={errorStyles} role="alert">
          {site} already opens in {nameOf(existing.profile)}. Change its profile
          in its row above.
        </p>
      )}
      {invalid && (
        <p className={errorStyles} role="alert">
          {site} is not a site, like example.com, *.example.com or
          github.com/acme.
        </p>
      )}
    </div>
  );
};

/** A profile in a menu: its color and name. */
const ProfileChoice = ({ profile }: { profile: BrowserProfile }) => (
  <span className={choiceStyles}>
    <span
      aria-hidden
      className={smallDotStyles}
      style={{ backgroundColor: profile.color }}
    />
    {profile.name}
  </span>
);

const cardStyles = flex({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  direction: "column",
});

const cardHeadStyles = flex({
  align: "center",
  gap: 2.5,
  minBlockSize: 14,
  paddingBlock: 2,
  paddingInline: 4,
});

const dotStyles = circle({ flexShrink: 0, size: 3 });

const smallDotStyles = circle({ flexShrink: 0, size: 2 });

const cardNameStyles = css({
  color: "foreground",
  fontSize: "sm",
  fontWeight: "semibold",
  margin: 0,
});

const badgeStyles = css({
  backgroundColor: "fill",
  borderRadius: "full",
  color: "muted",
  fontSize: "xs",
  paddingBlock: 0.5,
  paddingInline: 2,
});

const cardActionsStyles = flex({
  align: "center",
  gap: 1,
  marginInlineStart: "auto",
});

// Padded as the other pages' cards are, so the first row clears the head's
// border as far as the last clears the card's edge.
const cardBodyStyles = flex({
  borderBlockStart: "1px solid {colors.border}",
  direction: "column",
  padding: 4,
});

const swatchesStyles = flex({ align: "center", gap: 2 });

const swatchStyles = circle({
  _checked: {
    boxShadow: "0 0 0 2px {colors.card}, 0 0 0 4px {colors.foreground}",
  },
  _disabled: { cursor: "not-allowed", opacity: 0.6 },
  border: "none",
  cursor: "pointer",
  padding: 0,
  size: 5,
});

const extensionsRowStyles = flex({
  borderBlockStart: "1px solid {colors.border}",
  direction: "column",
  gap: 2.5,
  paddingBlockStart: 3.5,
});

const rowTitleStyles = css({
  color: "foreground",
  fontSize: "sm",
  fontWeight: "medium",
});

const extensionListStyles = grid({
  gap: 2,
  // Two columns at most, so long names such as "1Password – Password
  // Manager" fit.
  gridTemplateColumns: {
    base: "minmax(0, 1fr)",
    lg: "repeat(2, minmax(0, 1fr))",
  },
  listStyle: "none",
  margin: 0,
  padding: 0,
});

const extensionStyles = flex({
  align: "center",
  border: "1px solid {colors.border}",
  borderRadius: "md",
  gap: 2.5,
  paddingBlock: 2,
  paddingInline: 2.5,
});

const extensionNameStyles = css({
  flexGrow: 1,
  fontSize: "sm",
  minInlineSize: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const addProfileStyles = css({ maxInlineSize: 120 });

const sitesSectionStyles = flex({ direction: "column", gap: 3 });

const sitesHeadStyles = flex({ direction: "column", gap: 1 });

const sitesTitleStyles = css({
  color: "foreground",
  fontSize: "md",
  fontWeight: "semibold",
  margin: 0,
});

const sitesCardStyles = flex({
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  direction: "column",
  paddingInline: 4,
});

const sitesListStyles = flex({
  direction: "column",
  listStyle: "none",
  margin: 0,
  padding: 0,
});

const siteRowStyles = grid({
  alignItems: "center",
  borderBlockEnd: "1px solid {colors.border}",
  gap: 3,
  gridTemplateColumns: "minmax(0, 1fr) auto auto",
  paddingBlock: 2.5,
});

const siteStyles = css({
  fontFamily: "mono",
  fontSize: "sm",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const removeSpaceStyles = css({ inlineSize: 8 });

const addSiteStyles = flex({
  "& > div": { borderBlockEnd: "none" },
  direction: "column",
  paddingBlockEnd: 1,
});

const choiceStyles = flex({ align: "center", gap: 2 });

const hintStyles = css({ color: "muted", fontSize: "xs", margin: 0 });

const errorStyles = css({
  color: "danger",
  fontSize: "xs",
  margin: 0,
  paddingBlockEnd: 2.5,
});
