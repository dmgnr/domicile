/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />

import { Button } from "@domicile-desktop/component-library/Button";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { DeviceAsk } from "@domicile-desktop/manganese-page-requests/DeviceAsk";
import { PageDialog } from "@domicile-desktop/manganese-page-requests/PageDialog";
import { PermissionAsk } from "@domicile-desktop/manganese-page-requests/PermissionAsk";
import { useDeviceRequest } from "@domicile-desktop/manganese-page-requests/useDeviceRequest";
import { useDialogRequest } from "@domicile-desktop/manganese-page-requests/useDialogRequest";
import { usePermissionRequest } from "@domicile-desktop/manganese-page-requests/usePermissionRequest";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  Extension,
  ExtensionPopup,
} from "@domicile-desktop/sdk/extension";
import { WEBVIEW_CLOSE_EVENT } from "@domicile-desktop/sdk/webview-element";
import { useEffect, useState } from "react";
import { css } from "../../styled-system/css";
import { useContentSize } from "./useContentSize";
import { useShown } from "./useShown";

type Props = {
  /** Host every click goes through. */
  domicile: Domicile;
  /** Extension this action belongs to. */
  extension: Extension;
  /**
   * The action was clicked. A popup its extension then asks for with
   * `action.openPopup()` opens on this bar.
   */
  onActivate: () => void;
  /**
   * Requests a popup, or `undefined` to close it. The desktop decides, because
   * an open popup takes the keyboard from the windows (see `AppWindow`).
   */
  onOpen: (popup: ExtensionPopup | undefined) => void;
  /** The open popup on this bar, any extension's. */
  opened: ExtensionPopup | undefined;
};

/**
 * An extension's toolbar action, drawn in the bar's tray.
 *
 * Every click calls `extensions.activate`, which grants `activeTab` on the
 * focused browser window. An action with a popup then opens it in a
 * `<webview>` panel; the engine dispatches `action.onClicked` for one without.
 * The panel also opens for a popup its extension asked for with
 * `action.openPopup()`, which `opened` carries. It is withheld until the
 * popup's page has loaded, as Chrome's is.
 *
 * The panel closes on an outside press, Escape, or the popup's
 * `window.close()`. Escape works only while the shell page has the keyboard,
 * since keys pressed in the popup never reach it.
 */
export const ExtensionAction = ({
  domicile,
  extension,
  onActivate,
  onOpen,
  opened,
}: Props) => {
  const { id, popup, profile } = extension;
  // `null` because React passes it to a callback ref on unmount.
  const [view, setView] = useState<HTMLWebViewElement | null>(null);
  const shown = useShown(view);
  const shownPopup = opened?.id === id ? opened : undefined;
  return (
    <Popover
      align="start"
      flush
      onOpenChange={(opening) => {
        if (opening) {
          onActivate();
          domicile.extensions.activate(id);
          if (popup !== undefined) {
            onOpen({ id, popup, profile });
          }
        } else {
          onOpen(undefined);
        }
      }}
      open={shownPopup !== undefined}
      side="bottom"
      trigger={
        <Button label={extension.title} size="sm" variant="ghost">
          <Icon extension={extension} />
        </Button>
      }
      withheld={!shown}
    >
      {shownPopup !== undefined && (
        <PopupView
          // A popup in another profile is another page.
          key={shownPopup.profile}
          name={extension.name}
          onClose={() => {
            onOpen(undefined);
          }}
          popup={shownPopup.popup}
          profile={shownPopup.profile}
          setView={setView}
          view={view}
        />
      )}
    </Popover>
  );
};

/** An action's icon, with its badge over the corner when it has one. */
const Icon = ({ extension }: { extension: Extension }) => (
  <span className={iconStyles}>
    <img
      alt=""
      className={imageStyles}
      // Dragging reorders the tray, so the image itself is not draggable.
      draggable={false}
      src={extension.icon}
    />
    {extension.badgeText !== "" && (
      <span
        className={badgeStyles}
        // Inline because Panda can't read runtime values. `#rrggbbaa`,
        // transparent when the extension set none.
        style={{ backgroundColor: extension.badgeColor }}
      >
        {extension.badgeText}
      </span>
    )}
  </span>
);

type PopupViewProps = {
  /** The extension's name, for its permission requests. */
  name: string;
  /** The popup called `window.close()`. */
  onClose: () => void;
  popup: string;
  /** The browser profile the extension is in, which the popup opens in. */
  profile: string;
  /** Takes the view, as a callback ref. */
  setView: (view: HTMLWebViewElement | null) => void;
  /** The view `setView` took. */
  view: HTMLWebViewElement | null;
};

/**
 * The popup page in a `<webview>`.
 *
 * The view reports `window.close()` as `domicile-close` and leaves closing to
 * the shell. Like Chrome's popup, it sizes to the size its page sized itself
 * to (see `contentWidth` in `@domicile-desktop/sdk/webview-element`).
 *
 * The page's permission and device requests are asked above it. A grant is
 * the extension's, so it holds in the extension's other pages too. Its
 * dialogs cover it, and take focus, since the page is paused on them.
 */
const PopupView = ({
  name,
  onClose,
  popup,
  profile,
  setView,
  view,
}: PopupViewProps) => {
  const size = useContentSize(view);
  const request = usePermissionRequest(view);
  const deviceRequest = useDeviceRequest(view);
  const dialogRequest = useDialogRequest(view);

  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      view.addEventListener(WEBVIEW_CLOSE_EVENT, onClose);
      return () => {
        view.removeEventListener(WEBVIEW_CLOSE_EVENT, onClose);
      };
    }
  }, [onClose, view]);

  return (
    <>
      {request === undefined ? undefined : (
        <div className={askStyles}>
          <PermissionAsk asker={name} request={request} />
        </div>
      )}
      {deviceRequest === undefined ? undefined : (
        <div className={askStyles}>
          <DeviceAsk request={deviceRequest} />
        </div>
      )}
      <div className={pageStyles}>
        <webview
          className={viewStyles}
          // Marks the page as an action popup rather than a tab, so extensions
          // that lay out differently in a tab match Chrome. Read once, when the
          // view loads its page.
          extensionpopup=""
          // The extension's own profile, where its storage and sign-ins are.
          // Read once, when the view makes its page.
          profile={profile}
          ref={setView}
          src={popup}
          // Inline because Panda can't read runtime values.
          style={
            size === undefined
              ? undefined
              : { blockSize: size.height, inlineSize: size.width }
          }
        />
        {dialogRequest !== undefined && (
          <PageDialog asker={name} ref={focusDialog} request={dialogRequest} />
        )}
      </div>
    </>
  );
};

// Positions the badge.
const iconStyles = css({ display: "inline-flex", position: "relative" });

// Chrome's 16px toolbar icon size, in CSS pixels. The engine renders the PNG at
// the page's density.
const imageStyles = css({ blockSize: 4, inlineSize: 4 });

// Over the icon's lower corner, with white text, as in Chrome.
const badgeStyles = css({
  borderRadius: "sm",
  color: "white",
  fontSize: "2xs",
  fontVariantNumeric: "tabular-nums",
  insetBlockEnd: -1,
  insetInlineEnd: -1.5,
  lineHeight: "none",
  paddingBlock: 0.25,
  paddingInline: 0.5,
  position: "absolute",
  whiteSpace: "nowrap",
});

// Places a dialog over the page.
const pageStyles = css({ position: "relative" });

// The panel is flush, so the request gets its own inset.
const askStyles = css({ padding: 2 });

// `display: block` avoids a line-box gap under it in the panel.
const viewStyles = css({ borderStyle: "none", display: "block" });

/** Focuses a popup's dialog when it opens. */
const focusDialog = (element: HTMLElement | null): void => {
  if (element !== null) {
    element.focus();
  }
};
