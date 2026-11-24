import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { List, ListRow } from "@domicile-desktop/component-library/ListRow";
import { PanelSection } from "@domicile-desktop/component-library/PanelSection";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { Switch } from "@domicile-desktop/component-library/Switch";
import { Tooltip } from "@domicile-desktop/component-library/Tooltip";
import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import { LockIcon } from "@phosphor-icons/react/dist/ssr/Lock";
import { PushPinIcon } from "@phosphor-icons/react/dist/ssr/PushPin";
import type { CSSProperties } from "react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import { inkOn } from "./profile-ink";
import type { PinnedSite, ProfileExtension } from "./useBrowserProfile";

type Props = {
  /** The page's profile's extensions, which the menu switches. */
  extensions?: readonly ProfileExtension[] | undefined;
  /** Switches extension `id` on or off in the page's profile. */
  onSwitchExtension: (id: string, on: boolean) => void;
  /** Moves the page to profile `id`, in place. */
  onMove: (id: string) => void;
  /** Opens the page's address in a new window of profile `id`. */
  onOpenInNew: (id: string) => void;
  /** Opens the page's site, `pinned.site`, in profile `id` from now on. */
  onPin: (id: string) => void;
  /**
   * Where the page's site opens; `undefined` for a page that is no web site,
   * which has nothing to pin.
   */
  pinned?: PinnedSite | undefined;
  /** The page's profile. */
  profile: BrowserProfile;
  /** Every profile, in the config's order. */
  profiles: readonly BrowserProfile[];
  /**
   * The page's address. Must come from the same report as the page's other
   * address bar parts (see `useShownPage`).
   */
  url: string;
};

/**
 * The profile button at the start of the address bar: the page's profile in
 * its color, with a menu to move the page to another profile, open it in a
 * new window of one, or pin its site to one. See
 * docs/architecture/BROWSER-PROFILES.md.
 */
export const ProfileMenu = ({
  extensions = [],
  onMove,
  onOpenInNew,
  onPin,
  onSwitchExtension,
  pinned,
  profile,
  profiles,
  url,
}: Props) => {
  const [open, setOpen] = useState(false);
  const pinnedTo = profiles.find((each) => each.id === pinned?.profile);
  return (
    <Popover
      align="start"
      onOpenChange={setOpen}
      open={open}
      side="bottom"
      title={
        <span className={headingStyles}>
          <span aria-hidden className={dotStyles} style={colored(profile)} />
          {profile.name}
        </span>
      }
      tooltip="Browser profile"
      trigger={
        <button
          aria-label={`Browser profile: ${profile.name}`}
          className={chipStyles}
          style={colored(profile)}
          type="button"
        >
          {profile.name}
          <CaretDownIcon size={11} weight="bold" />
        </button>
      }
      wide
    >
      <PanelSection label="Profiles">
        <List>
          {profiles.map((each) => {
            const current = each.id === profile.id;
            const row = {
              actions: (
                <>
                  {pinned === undefined || pinned.locked ? undefined : (
                    <PinButton
                      onPin={() => {
                        onPin(each.id);
                      }}
                      pinned={each.id === pinned.profile}
                      profile={each}
                      site={pinned.site}
                    />
                  )}
                  <Tooltip
                    content={`Open in a new ${each.name} window`}
                    trigger={
                      <IconButton
                        label={`Open in a new ${each.name} window`}
                        onClick={() => {
                          setOpen(false);
                          onOpenInNew(each.id);
                        }}
                        size="sm"
                      >
                        <ArrowSquareOutIcon />
                      </IconButton>
                    }
                  />
                </>
              ),
              end: current ? (
                <CheckIcon aria-label="Current" className={checkStyles} />
              ) : undefined,
              icon: (
                <span aria-hidden className={dotStyles} style={colored(each)} />
              ),
              label: each.name,
            };
            return (
              <ListRow
                key={each.id}
                {...row}
                name={
                  current
                    ? `${each.name}, this page's profile`
                    : `Move this page to ${each.name}`
                }
                onPress={() => {
                  setOpen(false);
                  if (!current) {
                    onMove(each.id);
                  }
                }}
                // As a link opened in a new tab: a copy, in a new window.
                onPressInNew={() => {
                  setOpen(false);
                  onOpenInNew(each.id);
                }}
              />
            );
          })}
        </List>
      </PanelSection>
      {extensions.length === 0 ? undefined : (
        <PanelSection label={`Extensions in ${profile.name}`}>
          <List>
            {extensions.map((extension) => (
              <ListRow
                end={
                  <>
                    {extension.locked ? (
                      <LockIcon
                        aria-label={SET_IN_CONFIG}
                        className={lockStyles}
                        role="img"
                      />
                    ) : undefined}
                    <Switch
                      checked={extension.enabled}
                      disabled={extension.locked}
                      hideLabel
                      label={extension.name}
                      onCheckedChange={(on) => {
                        onSwitchExtension(extension.id, on);
                      }}
                    />
                  </>
                }
                icon={
                  <img alt="" className={iconStyles} src={extension.icon} />
                }
                key={extension.id}
                label={extension.name}
              />
            ))}
          </List>
        </PanelSection>
      )}
      <span className={siteStyles}>
        {pinned === undefined || pinnedTo === undefined ? (
          hostOf(url)
        ) : (
          <>
            {pinned.locked ? (
              <LockIcon aria-hidden className={lockStyles} />
            ) : undefined}
            {siteNote(pinned, pinnedTo)}
          </>
        )}
      </span>
    </Popover>
  );
};

/**
 * A profile row's pin: filled on the profile the page's site opens in, and on
 * any other, pins the site there.
 */
const PinButton = ({
  onPin,
  pinned,
  profile,
  site,
}: {
  onPin: () => void;
  pinned: boolean;
  profile: BrowserProfile;
  site: string;
}) => {
  const label = pinned
    ? `${site} opens in ${profile.name} by default`
    : `Open ${site} in ${profile.name} by default`;
  return (
    <Tooltip
      content={label}
      trigger={
        <IconButton
          aria-pressed={pinned}
          label={label}
          onClick={pinned ? undefined : onPin}
          size="sm"
        >
          <PushPinIcon weight={pinned ? "fill" : "regular"} />
        </IconButton>
      }
    />
  );
};

/** The line under the profiles that says where the page's site opens. */
const siteNote = (pinned: PinnedSite, to: BrowserProfile): string => {
  if (pinned.locked) {
    return `Your config opens ${pinned.site} in ${to.name}.`;
  }
  return to.isDefault
    ? `${pinned.site} opens in ${to.name}, your default profile.`
    : `${pinned.site} is pinned to ${to.name}.`;
};

/** `url`'s host, or `url` itself when it has none. */
const hostOf = (url: string): string => {
  try {
    const { host } = new URL(url);
    return host === "" ? url : host;
  } catch {
    return url;
  }
};

/**
 * Inline style handing the profile's color to the styles below as
 * `--profile-color`, and the text color on it as `--profile-ink`. Inline because the color is the config's, at runtime.
 */
const colored = (
  profile: BrowserProfile,
): CSSProperties & Record<`--${string}`, string> => ({
  "--profile-color": profile.color,
  "--profile-ink": inkOn(profile.color),
});

// A solid capsule in the profile's color before the address, as the private
// label was, so the page's profile shows on every page.
// Hovered and pressed as the shared Button's tinted variants are.
const chipStyles = hstack({
  _focusVisible: { outline: "2px solid {colors.accent}", outlineOffset: 1 },
  backgroundColor: {
    _activeEnabled:
      "color-mix(in oklab, var(--profile-color) 80%, {colors.background})",
    _hoverEnabled:
      "color-mix(in oklab, var(--profile-color) 70%, {colors.foreground})",
    base: "var(--profile-color)",
  },
  blockSize: 6,
  border: "none",
  borderRadius: "full",
  color: "var(--profile-ink)",
  cursor: "pointer",
  flex: "none",
  fontSize: "sm",
  fontWeight: "semibold",
  gap: 1,
  paddingInlineEnd: 2,
  paddingInlineStart: 2.5,
  transition: "background-color {durations.fastest} {easings.linear}",
});

const dotStyles = css({
  backgroundColor: "var(--profile-color)",
  blockSize: 2.5,
  borderRadius: "full",
  display: "inline-block",
  flex: "none",
  inlineSize: 2.5,
});

const headingStyles = hstack({ gap: 2 });

const checkStyles = css({ color: "accent" });

const SET_IN_CONFIG = "Set in your config";

// Chrome's 16px toolbar icon size, as the tray's icons.
const iconStyles = css({ blockSize: 4, inlineSize: 4, objectFit: "contain" });

const lockStyles = css({
  flex: "none",
  marginInlineEnd: 1,
  verticalAlign: "-0.125em",
});

const siteStyles = css({
  color: "muted",
  fontSize: "xs",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
