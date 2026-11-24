import { AnimatedCaretIcon } from "@domicile-desktop/component-library/AnimatedCaretIcon";
import { AnimatedMinusIcon } from "@domicile-desktop/component-library/AnimatedMinusIcon";
import { AnimatedPlusIcon } from "@domicile-desktop/component-library/AnimatedPlusIcon";
import { AnimatedReloadIcon } from "@domicile-desktop/component-library/AnimatedReloadIcon";
import type { Suggestion } from "@domicile-desktop/component-library/Autocomplete";
import { Autocomplete } from "@domicile-desktop/component-library/Autocomplete";
import { Button } from "@domicile-desktop/component-library/Button";
import type { AddressSuggestion } from "@domicile-desktop/manganese-address/address-suggestions";
import {
  AddressSuggestionKind,
  addressSuggestions,
} from "@domicile-desktop/manganese-address/address-suggestions";
import type { ConnectionSafety } from "@domicile-desktop/manganese-address/connection-safety";
import { typedAddress } from "@domicile-desktop/manganese-address/typed-address";
import type { SitePermission } from "@domicile-desktop/manganese-page-requests/site-permissions";
import type { PermissionRequest } from "@domicile-desktop/manganese-page-requests/usePermissionRequest";
import type {
  WebViewPermission,
  WebViewPermissionSetting,
} from "@domicile-desktop/sdk/webview-element";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/ssr/ClockCounterClockwise";
import { DetectiveIcon } from "@phosphor-icons/react/dist/ssr/Detective";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/ssr/GlobeSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import type { CSSProperties, FormEvent } from "react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { HistoryButton } from "./HistoryButton";
import type { MediaDeviceChoice } from "./media-devices";
import { ProfileMenu } from "./ProfileMenu";
import type { PageHistoryChoice } from "./page-history";
import { SitePermissions } from "./SitePermissions";
import {
  isFullyZoomedIn,
  isFullyZoomedOut,
  isUnzoomed,
  zoomPercent,
} from "./zoom-steps";

/** What the profile button shows and does; see {@link ProfileMenu}. */
export type ProfileChoice = Omit<Parameters<typeof ProfileMenu>[0], "url">;

type Props = {
  /**
   * The address shown while the user is not typing: the current page, or the
   * pending one.
   *
   * Must come from the same report as `security` (see `useShownPage`), or the
   * lock could describe a different page, which enables address-bar spoofing.
   */
  address: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * The page's history, for Back's and Forward's menus, or nothing from an
   * engine without history entries.
   */
  history: PageHistoryChoice | undefined;
  /** Keeps the zoom controls at 100%, while the zoom popup hangs from them. */
  holdZoom: boolean;
  /**
   * The cameras and microphones the site permissions panel picks from, or
   * nothing from an engine without them.
   */
  mediaDevices?: MediaDeviceChoice | undefined;
  /** Whether the window is private, which the bar says in its own color. */
  isPrivate: boolean;
  /**
   * The page's browser profile and the others, for the profile button; or
   * nothing while the engine has not listed them, when a private page is
   * labeled Private instead.
   */
  profile?: ProfileChoice | undefined;
  /** How far the page has loaded, from 0 to 1. Shown only while `loading`. */
  loadProgress: number;
  /** Whether a page is loading, which turns Reload into Stop. */
  loading: boolean;
  onBack: () => void;
  /** Goes back in a new window, for a middle click on Back. */
  onBackInNewWindow: () => void;
  onForward: () => void;
  /** Goes forward in a new window, for a middle click on Forward. */
  onForwardInNewWindow: () => void;
  /** Loads `url`, already resolved from what was typed. */
  onNavigate: (url: string) => void;
  onReload: () => void;
  /** Opens the History app, from Back's and Forward's menus. */
  onShowAllHistory: () => void;
  /** Stores a site permission for the page's site. */
  onSetSitePermission: (
    permission: WebViewPermission,
    setting: WebViewPermissionSetting,
  ) => void;
  onStop: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  /** The permission request the page is waiting on, if any. */
  permissionRequest: PermissionRequest | undefined;
  /** The browser's security state for {@link Props.address}. */
  security: ConnectionSafety;
  /** The page's site's permission settings. */
  sitePermissions: readonly SitePermission[];
  /** Visited addresses, oldest first. */
  visited: readonly string[];
  /** The page zoom factor; 1 is 100%. */
  zoom: number;
};

/**
 * A browser window's toolbar: history controls, the page's browser profile,
 * address field with the connection and site permissions, and zoom.
 * The desk's downloads show on the bar instead.
 *
 * Follows Chromium's layout, which users already know.
 */
export const AddressBar = ({
  address,
  canGoBack,
  canGoForward,
  history,
  holdZoom,
  isPrivate,
  loadProgress,
  loading,
  mediaDevices,
  onBack,
  onBackInNewWindow,
  onForward,
  onForwardInNewWindow,
  onNavigate,
  onReload,
  onSetSitePermission,
  onShowAllHistory,
  onStop,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  permissionRequest,
  profile,
  security,
  sitePermissions,
  visited,
  zoom,
}: Props) => {
  // Typing is discarded when the address changes. Reset during render, not in
  // an effect, to avoid a frame showing stale text over the new page.
  const [edit, setEdit] = useState({ address, typed: address });
  if (edit.address !== address) {
    setEdit({ address, typed: address });
  }
  const typed = edit.address === address ? edit.typed : address;

  const type = (next: string) => {
    setEdit({ address, typed: next });
  };

  // Enter on an empty line does nothing, as in other browsers.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const action = typedAddress(typed);
    if (action !== undefined) {
      onNavigate(action.url);
    }
  };

  return (
    <form
      className={barStyles}
      data-private={isPrivate ? "" : undefined}
      onSubmit={submit}
    >
      <div className={historyStyles}>
        <HistoryButton
          disabled={!canGoBack}
          history={history}
          label="Back"
          onShowAllHistory={onShowAllHistory}
          onStep={onBack}
          onStepInNewWindow={onBackInNewWindow}
        >
          <AnimatedCaretIcon pointing="left" size={16} />
        </HistoryButton>
        <HistoryButton
          disabled={!canGoForward}
          history={history}
          label="Forward"
          onShowAllHistory={onShowAllHistory}
          onStep={onForward}
          onStepInNewWindow={onForwardInNewWindow}
        >
          <AnimatedCaretIcon pointing="right" size={16} />
        </HistoryButton>
        {/* One button for Reload and Stop, since only one applies at a time. */}
        <Button
          label={loading ? "Stop" : "Reload"}
          onClick={loading ? onStop : onReload}
          rounded
          size="sm"
          variant="ghost"
        >
          <AnimatedReloadIcon loading={loading} size={16} />
        </Button>
      </div>
      {profile === undefined ? (
        isPrivate && (
          <span className={privateStyles}>
            <DetectiveIcon size={16} weight="fill" />
            Private
          </span>
        )
      ) : (
        <ProfileMenu {...profile} url={address} />
      )}
      <Autocomplete
        aria-label="Address"
        autoComplete="off"
        // Highlights the first suggestion, which is what the typed text would
        // do (see `addressSuggestions`), so Enter takes it and the field
        // completes inline.
        //
        // Off for an empty line, where the list is only history: Enter then
        // reaches the form, which ignores it.
        autoHighlight={typed.trim() !== ""}
        filled
        onSuggestionTaken={onNavigate}
        onValueChange={type}
        prefixButtons={
          <>
            <ConnectionIndicator security={security} url={address} />
            <SitePermissions
              devices={mediaDevices}
              onSet={onSetSitePermission}
              permissions={sitePermissions}
              request={permissionRequest}
              url={address}
            />
          </>
        }
        size="sm"
        spellCheck={false}
        suggestions={suggestionsFor(typed, visited)}
        value={typed}
      />
      {/* At the inline end, as in Chrome, and only while the page is
          zoomed or the zoom popup shows. Styled as a capsule beside
          the address field. */}
      {(!isUnzoomed(zoom) || holdZoom) && (
        <div aria-label="Zoom" className={zoomStyles} role="group">
          <Button
            disabled={isFullyZoomedOut(zoom)}
            label="Zoom out"
            onClick={onZoomOut}
            rounded
            size="xs"
            variant="ghost"
          >
            <AnimatedMinusIcon size={12} />
          </Button>
          <span aria-hidden className={dividerStyles} />
          {/* The zoom level; pressing it resets to 100%. Fixed width so the
            bar does not shift as the number changes. */}
          <span className={readoutStyles}>
            <Button
              onClick={onZoomReset}
              rounded
              size="xs"
              title="Reset zoom"
              variant="ghost"
            >
              {zoomPercent(zoom)}
            </Button>
          </span>
          <span aria-hidden className={dividerStyles} />
          <Button
            disabled={isFullyZoomedIn(zoom)}
            label="Zoom in"
            onClick={onZoomIn}
            rounded
            size="xs"
            variant="ghost"
          >
            <AnimatedPlusIcon size={12} weight="bold" />
          </Button>
        </div>
      )}
      {loading && (
        <div
          aria-label="Loading"
          aria-valuenow={Math.round(loadProgress * 100)}
          className={loadingStyles}
          role="progressbar"
          style={filledTo(loadProgress)}
        />
      )}
    </form>
  );
};

/**
 * Inline style handing `progress` to `loadingStyles` as `--load-progress`.
 * Inline because Panda only extracts build-time literals.
 */
const filledTo = (
  progress: number,
): CSSProperties & Record<`--${string}`, string> => ({
  "--load-progress": String(progress),
});

/** The suggestion list for the typed text. */
const suggestionsFor = (
  typed: string,
  visited: readonly string[],
): readonly Suggestion<string>[] =>
  addressSuggestions(typed, visited).map(lineFor);

/**
 * One suggestion as a list line.
 *
 * `text` fills the field when the line is highlighted. For a search it is the
 * query, not the search URL, so the user can keep editing their words.
 */
const lineFor = (suggestion: AddressSuggestion): Suggestion<string> => {
  switch (suggestion.kind) {
    case AddressSuggestionKind.Search: {
      return {
        description: "Search",
        icon: <MagnifyingGlassIcon size={14} />,
        label: suggestion.query,
        text: suggestion.query,
        value: suggestion.url,
      };
    }
    case AddressSuggestionKind.Site: {
      return {
        description: "Open",
        icon: <GlobeSimpleIcon size={14} />,
        label: suggestion.url,
        text: suggestion.url,
        value: suggestion.url,
      };
    }
    case AddressSuggestionKind.Visited: {
      return {
        description: "Visited",
        icon: <ClockCounterClockwiseIcon size={14} />,
        label: suggestion.url,
        text: suggestion.url,
        value: suggestion.url,
      };
    }
  }
};

// The open tab's surface, so the bar reads as chrome, not page, and joins the
// tab above. A private window's bar is tinted its own color, so it is
// never mistaken for an ordinary one.
const barStyles = hstack({
  // The address in 13px, the desktop's text size, rather than the field's.
  "& input[aria-label=Address]": { fontSize: "ui" },
  "&[data-private]": {
    backgroundColor:
      "color-mix(in oklab, {colors.private} 35%, {colors.background})",
    borderBlockEndColor: "private",
  },
  backgroundColor: "chrome",
  borderBlockEnd: "1px solid {colors.border}",
  flex: "none",
  gap: 2,
  paddingBlock: 1.5,
  paddingInline: 2,
  // Anchors the loading bar.
  position: "relative",
});

// A solid capsule before the address, so a private window says so in words
// as well as color.
const privateStyles = hstack({
  backgroundColor: "private",
  blockSize: 6,
  borderRadius: "full",
  color: "background",
  flex: "none",
  fontSize: "sm",
  fontWeight: "semibold",
  gap: 1,
  paddingInline: 2.5,
});

// Tighter than the bar's gap, so the three buttons read as one group.
const historyStyles = hstack({
  flex: "none",
  gap: 0.5,
});

// Matches the address field's height, fill and corners. The buttons are a
// size smaller so they sit inside its edge.
const zoomStyles = hstack({
  backgroundColor: "card",
  blockSize: 6,
  borderRadius: "lg",
  flex: "none",
  gap: 1,
  paddingInline: 0.5,
});

// Fits the widest value, 500%, with fixed-width digits.
const readoutStyles = css({
  display: "inline-flex",
  fontVariantNumeric: "tabular-nums",
  justifyContent: "center",
  minInlineSize: 14,
});

const dividerStyles = css({
  backgroundColor: "border",
  blockSize: 3,
  flex: "none",
  inlineSize: "1px",
});

// A bar along the address bar's bottom edge, over the border, filled as far as
// the page has loaded. Grows from the left: `transform-origin` takes no
// logical keyword.
const loadingStyles = css({
  _before: {
    backgroundColor: "accent",
    content: '""',
    inset: 0,
    position: "absolute",
    transform: "scaleX(var(--load-progress))",
    transformOrigin: "left",
    transition: "transform {durations.normal} {easings.out}",
  },
  blockSize: 0.5,
  insetBlockEnd: "-1px",
  insetInline: 0,
  overflow: "hidden",
  pointerEvents: "none",
  position: "absolute",
});
