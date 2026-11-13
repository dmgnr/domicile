/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />

import { FilePicker } from "@domicile-desktop/component-library/FilePicker";
import { desktopFolders } from "@domicile-desktop/component-library/folders";
import { DeviceAsk } from "@domicile-desktop/manganese-page-requests/DeviceAsk";
import { ExternalAppAsk } from "@domicile-desktop/manganese-page-requests/ExternalAppAsk";
import { IdentityAsk } from "@domicile-desktop/manganese-page-requests/IdentityAsk";
import { PageDialog } from "@domicile-desktop/manganese-page-requests/PageDialog";
import { PickerAsk } from "@domicile-desktop/manganese-page-requests/PickerAsk";
import { PromptAsk } from "@domicile-desktop/manganese-page-requests/PromptAsk";
import { SignInAsk } from "@domicile-desktop/manganese-page-requests/SignInAsk";
import { useDeviceRequest } from "@domicile-desktop/manganese-page-requests/useDeviceRequest";
import { useDialogRequest } from "@domicile-desktop/manganese-page-requests/useDialogRequest";
import { useExternalAppRequest } from "@domicile-desktop/manganese-page-requests/useExternalAppRequest";
import { useIdentityRequest } from "@domicile-desktop/manganese-page-requests/useIdentityRequest";
import { useLinkOpener } from "@domicile-desktop/manganese-page-requests/useLinkOpener";
import { usePermissionRequest } from "@domicile-desktop/manganese-page-requests/usePermissionRequest";
import { usePickerRequest } from "@domicile-desktop/manganese-page-requests/usePickerRequest";
import { usePromptRequest } from "@domicile-desktop/manganese-page-requests/usePromptRequest";
import { useSignInRequest } from "@domicile-desktop/manganese-page-requests/useSignInRequest";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import {
  WEBVIEW_DIALOG_EVENT,
  WEBVIEW_FOCUS_REQUEST_EVENT,
  WEBVIEW_GUEST_FOCUS_EVENT,
  WEBVIEW_GUEST_KEYDOWN_EVENT,
  WEBVIEW_ZOOM_IN_REQUEST_EVENT,
  WEBVIEW_ZOOM_OUT_REQUEST_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import type { FocusEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { css, cx } from "../styled-system/css";
import { flex } from "../styled-system/patterns";
import { AddressBar } from "./browser/AddressBar";
import { AppAddress } from "./browser/AppAddress";
import { leftOrigin } from "./browser/app-origin";
import { BrowserCommand, browserCommandFor } from "./browser/browser-command";
import { FindBar } from "./browser/FindBar";
import { LinkTarget } from "./browser/LinkTarget";
import { mediaDeviceChoiceFor } from "./browser/media-devices";
import { PageMenu } from "./browser/PageMenu";
import { PagePopup } from "./browser/PagePopup";
import { PageProblem } from "./browser/PageProblem";
import { PageTooltip } from "./browser/PageTooltip";
import { choosePageCommand, pageMenuFor } from "./browser/page-menu";
import { useFileRequest } from "./browser/useFileRequest";
import { usePageMenu } from "./browser/usePageMenu";
import { useSitePermissions } from "./browser/useSitePermissions";
import { useZoomPopup } from "./browser/useZoomPopup";
import { ZoomPanel } from "./browser/ZoomPanel";
import { zoomedIn, zoomedOut } from "./browser/zoom-steps";
import { endsOwnAnimation } from "./own-animation";
import { CROSSING } from "./placement";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { useHistoryAvailability } from "./useHistoryAvailability";
import { useLoading } from "./useLoading";
import { useLoadProgress } from "./useLoadProgress";
import { useLowered } from "./useLowered";
import { usePageDescription } from "./usePageDescription";
import { usePageFullscreen } from "./usePageFullscreen";
import { usePageIcon } from "./usePageIcon";
import { usePageProblem } from "./usePageProblem";
import { useReclaimFocus } from "./useReclaimFocus";
import type { Settler } from "./useSettling";
import { UPRIGHT, useSettling } from "./useSettling";
import { useShownPage } from "./useShownPage";
import { useZoom } from "./useZoom";
import type { WindowMotion } from "./window-motion";
import { isLeaving, isMoving, isSlidingIn } from "./window-motion";
import {
  bottomCornerStyles,
  clickThroughStyles,
  contentsScaledAbout,
  edgeStyles,
  heldStyles,
  keptAt,
  movingStyles,
  originOf,
  placedAt,
  settlingStyles,
  shuffledBy,
  windowStyles,
} from "./window-styles";

type Props = {
  /**
   * Whether a desktop panel, such as the launcher, covers the desktop. Opening
   * one hands the page the keyboard, and the engine then refocuses the last
   * guest as if clicked. A covered page cannot be clicked, so that is not a
   * user reach (see `onReach`).
   */
  behindPanel: boolean;
  /**
   * Used to tell the host that no client holds the keyboard, and to list
   * directories for the file picker. The page lives in the shell's own window,
   * so focusing it takes focus from any client.
   */
  domicile: Domicile;
  /** Whether the pointer passes through this window, as during a drag. */
  clickThrough: boolean;
  /**
   * Whether another tab in its container covers it. A covered page cannot be
   * clicked, so its guest taking focus is not a user reach (see `onReach`).
   */
  covered: boolean;
  /**
   * Whether it just moved to another tab group, so it eases there over the
   * strips it passes. See `crossing.ts`.
   */
  crossing?: boolean | undefined;
  /** The window's `z-index`, which the SDK reports to the host. */
  depth: number;
  /**
   * Whether the user is dragging or resizing this window, so its box follows
   * the pointer.
   */
  dragging: boolean;
  /** Whether the shell considers this window focused. */
  focused: boolean;
  /**
   * The box spanning the title bar and contents; the transform origin (see
   * {@link scaledAbout}). `undefined` when {@link Props.rect} is.
   */
  frame: Rect | undefined;
  /**
   * Its tab in the strip, which its contents grow out of as it opens and
   * shrink into as it closes (see {@link contentsScaledAbout}).
   */
  tab?: Rect | undefined;
  /** Whether this window is fullscreen, which removes its edge and corners. */
  fullscreen: boolean;
  /** Lists a directory for the file picker. */
  folders?: typeof desktopFolders;
  /**
   * The window's current animation, if any.
   *
   * A leaving window keeps showing its page but requests no keyboard, takes
   * no pointer and is inert.
   */
  motion: WindowMotion;
  /**
   * Called when the motion's animation ends, so a closed window can be
   * removed. Uses the animation event so the duration lives only in CSS.
   */
  onMotionEnded: () => void;
  /**
   * The page's description, `""` for none, with {@link Props.window}. See
   * `usePageDescription`.
   */
  onDescription: (window: string, description: string) => void;
  /**
   * The page's icon URL, `""` for none, with {@link Props.window}. See
   * `usePageIcon`.
   */
  onIcon: (window: string, icon: string) => void;
  /**
   * The page entered or left fullscreen, as a video's fullscreen button does.
   * The window should fill its screen while it is. See `usePageFullscreen`.
   */
  /**
   * Called when the page (`window.focus()`, or `client.focus()` from a
   * notification click) or an extension asks for this window in front. See
   * `WEBVIEW_FOCUS_REQUEST_EVENT`.
   */
  onFocusRequest: () => void;
  onPageFullscreen: (fullscreen: boolean) => void;
  /**
   * Called when the user moves focus into this window (page or address bar).
   * Fires for every click, since a click raises the window even when it is
   * already focused.
   *
   * Clicks inside the guest page send no pointer or focus events to this
   * document, so the element reports them with
   * {@link WEBVIEW_GUEST_FOCUS_EVENT}.
   */
  onReach: () => void;
  /**
   * The `chrome.windows` id for an extension popup window, or `undefined` for
   * a normal browser window. Popup windows have no address bar, as in Chrome.
   */
  popupWindow?: number | undefined;
  /**
   * Whether this is an app window (`domicile open --app`), drawn without an
   * address bar. See docs/architecture/WEB-APPS.md.
   */
  isApp?: boolean;
  /**
   * Whether the page is private. The address bar says so, and the page's new
   * windows are private too.
   */
  isPrivate?: boolean;
  /**
   * The contents' box, or `undefined` when off screen (another workspace, or
   * behind a tab).
   */
  rect: Rect | undefined;
  /**
   * Whether the user is resizing windows with the pointer. Sets the
   * `<webview>`'s `resizing` attribute, so the engine shows each new box
   * without waiting for the page to draw at it.
   */
  resizing: boolean;
  /** The restack shuffle in progress, if any. See `shuffledBy`. */
  restack?: Restack | undefined;
  /** Eases the window into a new box; see `useSettling`. */
  settler?: Settler | undefined;
  /**
   * The page's URL from the engine's last list. The bar shows it until the
   * view reports one.
   */
  url: string;
  /**
   * The engine's browser window id, set as the view's `window` attribute.
   *
   * The engine reads it once when the view is inserted, so it must not change.
   * A recreated view is refused while the first one holds the page.
   */
  window: string;
};

/**
 * A browser window: an address bar over a `<webview>`. See
 * `docs/SHELL-BROWSER-WINDOWS.md` and
 * `packages/manganese-window-management/docs/FOCUS-INTERNALS.md`.
 */
export const BrowserWindow = ({
  behindPanel,
  clickThrough,
  covered,
  crossing = false,
  depth,
  domicile,
  dragging,
  focused,
  frame,
  fullscreen,
  isApp = false,
  isPrivate = false,
  folders: foldersOf = desktopFolders,
  motion,
  onDescription,
  onFocusRequest,
  onIcon,
  onMotionEnded,
  onPageFullscreen,
  onReach,
  popupWindow,
  rect,
  resizing,
  restack,
  settler,
  tab,
  url,
  window,
}: Props) => {
  // A leaving window still draws as focused but stops taking the keyboard,
  // which has moved to the next window.
  const leaving = isLeaving(motion);
  const holdsKeyboard = focused && !leaving;
  // Whether nothing can click the page, so its guest taking focus is the
  // engine's doing rather than the user's.
  const unclickable = covered || behindPanel;
  // `null` because React passes `null` to a callback ref on unmount.
  const [view, setView] = useState<HTMLWebViewElement | null>(null);
  // The whole window, used to check whether focus is inside it and to ease it
  // into a new box. A ref because only effects read it.
  const element = useRef<HTMLElement>(null);
  const lowered = useLowered(depth);
  // The box the window eases from, while it settles.
  const [settlingFrom, setSettlingFrom] = useState<Rect | undefined>(undefined);
  useSettling({
    element: element,
    onSettling: setSettlingFrom,
    origin:
      rect === undefined || frame === undefined
        ? undefined
        : originOf(frame, rect),
    over: crossing ? CROSSING : undefined,
    rect,
    settler,
    still: dragging || isMoving(motion),
  });
  // The URL the shell last navigated to. The bar shows it until the page
  // reports its own URL.
  const [sent, setSent] = useState(url);
  // The address an app window opened at, whose origin is the app's. Kept from
  // mount because `url` follows the page.
  const [start] = useState(url);
  // The page's actual URL and connection security, including navigations
  // the shell did not start (links, redirects, form posts).
  const shown = useShownPage(view);
  const address = addressOf(shown.url, sent);
  usePageIcon(view, window, onIcon);
  usePageDescription(view, window, onDescription);
  const { canGoBack, canGoForward } = useHistoryAvailability(view);
  const loading = useLoading(view);
  const loadProgress = useLoadProgress(view);
  // The zoom popup over the page. Only while the page is in front, so it
  // never sits over another window.
  const {
    close: closePopup,
    cue: popupCue,
    open: zoomShown,
    show: showPopup,
  } = useZoomPopup(holdsKeyboard && !covered);
  const zoom = useZoom(view);
  // A fullscreen page, such as a video, fills the window without its bar.
  const pageFullscreen = usePageFullscreen(view, fullscreen, onPageFullscreen);
  // True while `focusOwn` is calling `focus()`. Focus events fire
  // synchronously inside that call, so this marks them as not user reaches.
  const focusing = useRef(false);
  const folders = useMemo(
    () => foldersOf(domicile.files),
    [domicile, foldersOf],
  );
  // A pending file request from the page. The engine draws no dialog; see
  // `useFileRequest`.
  const asking = useFileRequest(view, folders);
  // The file picker's input. While open it takes the window's keyboard.
  const [pickerBox, setPickerBox] = useState<HTMLInputElement | null>(null);
  // Whether the find bar is open, and its input.
  const [finding, setFinding] = useState(false);
  const [findBox, setFindBox] = useState<HTMLInputElement | null>(null);
  // The context menu the page asked for. The engine draws none.
  const [menu, dismissMenu] = usePageMenu(view);
  // The page's site's permissions, and the request it is waiting on. The
  // engine draws no prompt; the address bar's site permissions panel does.
  const sitePermissions = useSitePermissions(view);
  // The camera and microphone a page that names none gets, picked in the
  // same panel.
  const mediaDevices = useMemo(
    () => (view === null ? undefined : mediaDeviceChoiceFor(view)),
    [view],
  );
  const permissionRequest = usePermissionRequest(view);
  // The device the page asked for. The engine draws no chooser; this window
  // asks over the page, address bar or not.
  const deviceRequest = useDeviceRequest(view);
  // The `alert()`, `confirm()`, `prompt()` or `beforeunload` the page is
  // paused on, and the element in it to focus. The engine draws no dialog.
  const dialogRequest = useDialogRequest(view);
  const [dialogBox, setDialogBox] = useState<HTMLElement | null>(null);
  // The link for an application the page opened, the application that opens
  // it, and the button to focus. The engine draws no dialog.
  const externalApp = useExternalAppRequest(view);
  const linkOpener = useLinkOpener(domicile, externalApp?.url);
  const [appAskBox, setAppAskBox] = useState<HTMLElement | null>(null);
  // The user name and password a site or proxy asked for, and the field to
  // focus. The engine draws no dialog.
  const signIn = useSignInRequest(view);
  const [signInBox, setSignInBox] = useState<HTMLElement | null>(null);
  // File access, a certificate, Bluetooth pairing or an extension's
  // permissions, and the element to focus. The engine draws no dialog.
  const prompt = usePromptRequest(view);
  const [promptBox, setPromptBox] = useState<HTMLElement | null>(null);
  // The "Sign in with" step the site's sign-in is on, and the answer to
  // focus when it asks over the page. The engine draws no account chooser.
  const identity = useIdentityRequest(view);
  const [identityBox, setIdentityBox] = useState<HTMLElement | null>(null);
  // The color, date or list picker a form control in the page opened, and
  // the element in it to focus. The engine draws no picker.
  const pagePicker = usePickerRequest(view);
  const [pagePickerBox, setPagePickerBox] = useState<HTMLElement | null>(null);
  // Why the page shows nothing: a failed load or a crash, which the shell
  // draws over the blank page; and its first answer, to focus.
  const problem = usePageProblem(view);
  const [problemBox, setProblemBox] = useState<HTMLElement | null>(null);
  // What the page waits on, which takes the keyboard while it is open.
  const waiting =
    pickerBox ??
    dialogBox ??
    signInBox ??
    promptBox ??
    identityBox ??
    appAskBox ??
    pagePickerBox ??
    problemBox;

  // Focuses an element in this window without reporting it as a user reach.
  // All programmatic focus here must go through this.
  //
  // Never scrolls: a window arriving with a workspace switch is off screen,
  // and scrolling it into view would scroll the whole desk.
  const focusOwn = useCallback((target: HTMLElement) => {
    focusing.current = true;
    target.focus({ preventScroll: true });
    focusing.current = false;
  }, []);

  // Reports a click in the guest page (see `onReach`).
  //
  // Ignored while nothing can click the page. When the page regains the
  // keyboard (such as when the launcher opens), the engine refocuses the last
  // guest and fires this event as if clicked, which would raise a hidden tab
  // or move focus to another screen.
  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      const reached = () => {
        if (!(focusing.current || unclickable)) {
          onReach();
        }
      };
      view.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reached);
      return () => {
        view.removeEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reached);
      };
    }
  }, [onReach, unclickable, view]);

  // The page or an extension asked to raise this window. See `onFocusRequest`.
  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      view.addEventListener(WEBVIEW_FOCUS_REQUEST_EVENT, onFocusRequest);
      return () => {
        view.removeEventListener(WEBVIEW_FOCUS_REQUEST_EVENT, onFocusRequest);
      };
    }
  }, [onFocusRequest, view]);

  // A page asking to stay is closing, perhaps behind a tab. Raise it so the
  // user sees the question, as Chrome switches to the tab.
  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      const asked = ({ dialogType }: DomicileDialogEvent) => {
        if (dialogType === "beforeunload") {
          onFocusRequest();
        }
      };
      view.addEventListener(WEBVIEW_DIALOG_EVENT, asked);
      return () => {
        view.removeEventListener(WEBVIEW_DIALOG_EVENT, asked);
      };
    }
  }, [onFocusRequest, view]);

  // Runs a browser command from a chord in the address bar, a chord the page
  // did not handle, or a button.
  //
  // Zoom steps from `view.zoom` at press time, not render state, because zoom
  // is per site and another window may have changed it.
  const run = useCallback(
    (command: BrowserCommand) => {
      if (view === null) {
        throw new Error("browser window: no view to drive");
      } else {
        switch (command) {
          case BrowserCommand.Back: {
            view.goBack();
            break;
          }
          // An open bar refocuses with its text selected, as in Chrome. A new
          // bar focuses on mount; see the effect below.
          case BrowserCommand.Find: {
            setFinding(true);
            if (findBox !== null) {
              focusOwn(findBox);
              findBox.select();
            }
            break;
          }
          case BrowserCommand.Forward: {
            view.goForward();
            break;
          }
          // The view asks the desktop for a DevTools window, as a
          // `target="_blank"` link does.
          case BrowserCommand.Inspect: {
            view.inspect();
            break;
          }
          case BrowserCommand.Print: {
            view.print();
            break;
          }
          case BrowserCommand.Reload: {
            view.reload();
            break;
          }
          case BrowserCommand.ZoomIn: {
            view.setZoom(zoomedIn(view.zoom));
            showPopup();
            break;
          }
          case BrowserCommand.ZoomOut: {
            view.setZoom(zoomedOut(view.zoom));
            showPopup();
            break;
          }
          case BrowserCommand.ZoomReset: {
            view.setZoom(1);
            showPopup();
            break;
          }
        }
      }
    },
    [findBox, focusOwn, showPopup, view],
  );

  // Focuses the find bar when it opens.
  useEffect(() => {
    if (findBox !== null) {
      focusOwn(findBox);
    }
  }, [findBox, focusOwn]);

  // Keys pressed in the guest never reach this document. The engine forwards
  // chords the page did not handle, and Ctrl+wheel as zoom requests, so sites
  // keep their own bindings as in Chrome. See `WEBVIEW_GUEST_KEYDOWN_EVENT`.
  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      const pressed = (event: KeyboardEvent) => {
        const command = browserCommandFor(event);
        if (command !== undefined) {
          run(command);
        }
      };
      const zoomIn = () => {
        run(BrowserCommand.ZoomIn);
      };
      const zoomOut = () => {
        run(BrowserCommand.ZoomOut);
      };
      view.addEventListener(WEBVIEW_GUEST_KEYDOWN_EVENT, pressed);
      view.addEventListener(WEBVIEW_ZOOM_IN_REQUEST_EVENT, zoomIn);
      view.addEventListener(WEBVIEW_ZOOM_OUT_REQUEST_EVENT, zoomOut);
      return () => {
        view.removeEventListener(WEBVIEW_GUEST_KEYDOWN_EVENT, pressed);
        view.removeEventListener(WEBVIEW_ZOOM_IN_REQUEST_EVENT, zoomIn);
        view.removeEventListener(WEBVIEW_ZOOM_OUT_REQUEST_EVENT, zoomOut);
      };
    }
  }, [run, view]);

  // Gives the keyboard to the focused window's page.
  //
  // - Calls `focusChrome` so the compositor stops sending keys to the last
  //   client and the engine stops forwarding this document's keys to it. The
  //   engine does this for `<app>` but not for `<webview>`.
  // - Skips the page if focus is already in this window. Otherwise a click in
  //   the address bar would have its focus pulled into the page.
  // - Focuses the file picker or the page's dialog instead while one is open,
  //   since the page is waiting on it.
  useEffect(() => {
    if (holdsKeyboard && view !== null) {
      domicile.windows.focusShell();
      if (waiting !== null) {
        focusOwn(waiting);
      } else if (!holdsFocus(element.current)) {
        focusOwn(view);
      }
    }
  }, [domicile, focusOwn, holdsKeyboard, view, waiting]);

  // Takes the keyboard back for the file picker or the page's dialog when the
  // waiting page takes focus. The PDF viewer refocuses its own button after
  // asking where to save, and the keys would follow it into the page.
  useEffect(() => {
    if (view === null || waiting === null) {
      return undefined;
    } else {
      const reclaim = () => {
        focusOwn(waiting);
      };
      view.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reclaim);
      return () => {
        view.removeEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reclaim);
      };
    }
  }, [focusOwn, view, waiting]);

  // Releases focus when the window loses it. The engine forwards keys from this
  // document to clients, but keys sent to a focused guest never reach the
  // document. A guest left focused would block typing into every client.
  useEffect(() => {
    if (!holdsKeyboard) {
      releaseFocus(element.current);
    }
  }, [holdsKeyboard]);

  // Restores focus if chrome takes it later, such as when another window
  // closes. See `useReclaimFocus`. Targets the picker or the dialog while one
  // is open. Not behind a panel or the lock screen, whose keys must not reach
  // the page.
  useReclaimFocus<HTMLElement>(
    waiting ?? view,
    holdsKeyboard && !behindPanel,
    focusOwn,
  );

  // The view is attached before any control can be pressed, so a missing view
  // is a bug.
  const withView = (command: (view: HTMLWebViewElement) => void): void => {
    if (view === null) {
      throw new Error("browser window: no view to drive");
    } else {
      command(view);
    }
  };

  // Opens a link from the page in another browser window, private when this
  // one is.
  const openWindow = (url: string): void => {
    if (isPrivate) {
      domicile.browser.openPrivate(url);
    } else {
      domicile.browser.open(url);
    }
  };

  const drive = (command: (view: HTMLWebViewElement) => void) => () => {
    withView(command);
  };

  // A popup, an app or a fullscreen page has no address bar.
  const hasAddressBar = popupWindow === undefined && !isApp && !pageFullscreen;

  // Reports focus entering this window as a user reach.
  const reach = (event: FocusEvent) => {
    // Skips focus from `focusOwn` and an unclickable guest regaining focus,
    // which also fires `focusin` on the view.
    if (!(focusing.current || (unclickable && event.target === view))) {
      onReach();
    }
  };

  // Closes the find bar and refocuses the page, keeping the current match
  // selected, as Escape does in Chrome.
  const stopFinding = () => {
    withView((loaded) => {
      loaded.stopFinding();
      focusOwn(loaded);
    });
    setFinding(false);
  };

  const navigate = (url: string) => {
    withView((loaded) => {
      // The attribute works without engine support; on a browser without
      // `<webview>` the property would not update the DOM.
      loaded.setAttribute("src", url);
      setSent(url);
    });
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a window is not a control; focus raises the window, and keydown runs browser chords pressed in its chrome
    <section
      aria-label="Browser"
      className={cx(
        windowStyles,
        browserStyles,
        // The title bar draws the top edge. Fullscreen has no edge or corners.
        !fullscreen && edgeStyles,
        !fullscreen && bottomCornerStyles,
        noTopEdgeStyles,
        movingStyles({ contents: true, motion }),
        (clickThrough || leaving) && clickThroughStyles,
        // The page's box takes its new size at once; `useSettling` eases it.
        // Colors still ease; see `settlingStyles`.
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      // Exposes the motion on the element for tests and debugging.
      data-motion={motion}
      hidden={rect === undefined}
      // A leaving window is unreachable by keyboard.
      inert={leaving}
      // Ignores animations bubbling up from descendants, such as the page
      // notices, and the end of a motion this one replaced.
      onAnimationEnd={(event) => {
        if (endsOwnAnimation(event)) {
          onMotionEnded();
        }
      }}
      // Focus rather than press, so keyboard focus counts too. Page clicks
      // arrive through `WEBVIEW_GUEST_FOCUS_EVENT`; see `onReach`.
      onFocus={reach}
      // Browser chords pressed in the address bar. `preventDefault` keeps the
      // input from also handling them.
      onKeyDown={(event) => {
        const command = browserCommandFor(event);
        if (command !== undefined) {
          event.preventDefault();
          run(command);
        }
      }}
      ref={element}
      // Inline because the box is a runtime value Panda cannot extract.
      style={
        rect === undefined || frame === undefined
          ? undefined
          : {
              ...placedAt(rect, depth),
              ...contentsScaledAbout(motion, frame, tab, rect),
              ...shuffledBy(restack),
            }
      }
    >
      {/*
        Kept at its own size while the window eases into a new box, which
        clips it, so the page is cropped rather than stretched.
      */}
      <div
        className={contentsStyles}
        // Inline because the size is a runtime value Panda cannot extract.
        style={rect === undefined ? undefined : keptAt(settlingFrom, rect)}
        {...{ [UPRIGHT]: "" }}
      >
        {hasAddressBar && (
          <AddressBar
            address={address}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            holdZoom={zoomShown}
            isPrivate={isPrivate}
            loading={loading}
            loadProgress={loadProgress}
            mediaDevices={mediaDevices}
            onBack={drive((loaded) => {
              loaded.goBack();
            })}
            onBackInNewWindow={drive((loaded) => {
              loaded.goBackInNewWindow();
            })}
            onForward={drive((loaded) => {
              loaded.goForward();
            })}
            onForwardInNewWindow={drive((loaded) => {
              loaded.goForwardInNewWindow();
            })}
            onNavigate={navigate}
            onReload={drive((loaded) => {
              loaded.reload();
            })}
            onSetSitePermission={(permission, setting) => {
              withView((loaded) => {
                loaded.setSitePermission(permission, setting);
              });
            }}
            onStop={drive((loaded) => {
              loaded.stop();
            })}
            onZoomIn={() => {
              run(BrowserCommand.ZoomIn);
            }}
            onZoomOut={() => {
              run(BrowserCommand.ZoomOut);
            }}
            onZoomReset={() => {
              run(BrowserCommand.ZoomReset);
            }}
            permissionRequest={permissionRequest}
            security={shown.security}
            sitePermissions={sitePermissions}
            visited={shown.visited}
            zoom={zoom}
          />
        )}
        {isApp && !pageFullscreen && leftOrigin(start, address) && (
          <AppAddress address={address} security={shown.security} />
        )}
        {/*
        Wraps the page so the find bar and file picker cover the page but not
        the address bar.
      */}
        <div className={pageStyles}>
          <webview
            className={viewStyles}
            ref={setView}
            // Also while the window settles, so the engine neither holds the
            // shell for the page nor stretches its old frame, and while it
            // slides in, so the slide does not wait for the page to draw
            // again.
            resizing={
              resizing || settlingFrom !== undefined || isSlidingIn(motion)
                ? ""
                : undefined
            }
            // React sets attributes before insertion, when the engine reads it.
            // See `window`.
            window={window}
          />
          {problem !== undefined && (
            <PageProblem
              canGoBack={canGoBack}
              // A new page per problem, so Details starts closed.
              key={problem.kind === "gone" ? problem.reason : problem.url}
              onGoBack={drive((loaded) => {
                loaded.goBack();
              })}
              onProceed={drive((loaded) => {
                loaded.proceedPastWarning();
              })}
              onReload={drive((loaded) => {
                loaded.reload();
              })}
              problem={problem}
              ref={setProblemBox}
            />
          )}
          {pagePicker !== undefined && (
            <PickerAsk
              // A new picker per request, so each starts at the page's value.
              key={[
                pagePicker.kind,
                pagePicker.value,
                pagePicker.anchor.x,
                pagePicker.anchor.y,
              ].join("\n")}
              ref={setPagePickerBox}
              request={pagePicker}
            />
          )}
          <LinkTarget view={view} />
          <PageTooltip view={view} />
          <PagePopup
            closesAfter={ZOOM_POPUP_MS}
            cue={popupCue}
            label="Zoom"
            onClose={closePopup}
            open={zoomShown}
          >
            <ZoomPanel
              onZoomIn={() => {
                run(BrowserCommand.ZoomIn);
              }}
              onZoomOut={() => {
                run(BrowserCommand.ZoomOut);
              }}
              onZoomReset={() => {
                run(BrowserCommand.ZoomReset);
              }}
              zoom={zoom}
            />
          </PagePopup>
          {finding && (
            <FindBar
              onClose={stopFinding}
              onFind={(text, backward) => {
                withView((loaded) => {
                  loaded.find(text, backward);
                });
              }}
              ref={setFindBox}
              view={view}
            />
          )}
          {menu !== undefined && (
            <PageMenu
              at={menu.at}
              items={pageMenuFor(menu.context, {
                canGoBack,
                canGoForward,
                zoom,
              })}
              onChoose={(command) => {
                choosePageCommand(command, menu.context, {
                  browse: run,
                  openWindow,
                });
              }}
              onClose={dismissMenu}
            />
          )}
          {deviceRequest !== undefined && (
            <div className={deviceAskStyles}>
              <DeviceAsk request={deviceRequest} />
            </div>
          )}
          {dialogRequest !== undefined && (
            <PageDialog ref={setDialogBox} request={dialogRequest} />
          )}
          {dialogRequest === undefined && signIn !== undefined && (
            <SignInAsk ref={setSignInBox} request={signIn} />
          )}
          {dialogRequest === undefined &&
            signIn === undefined &&
            prompt !== undefined && (
              <PromptAsk
                // A new answer per prompt, so each starts unanswered.
                key={[prompt.kind, prompt.subject, ...prompt.details].join(
                  "\n",
                )}
                ref={setPromptBox}
                request={prompt}
              />
            )}
          {dialogRequest === undefined &&
            signIn === undefined &&
            prompt === undefined &&
            identity !== undefined && (
              <IdentityAsk
                // A new card per step, so each starts unanswered.
                key={identity.step}
                onOpenLink={openWindow}
                ref={setIdentityBox}
                request={identity}
              />
            )}
          {dialogRequest === undefined &&
            signIn === undefined &&
            prompt === undefined &&
            externalApp !== undefined &&
            linkOpener !== undefined && (
              <ExternalAppAsk
                app={linkOpener}
                ref={setAppAskBox}
                request={externalApp}
              />
            )}
          {asking !== undefined && (
            <FilePicker
              // A new picker per request, so each starts empty.
              key={asking.serial}
              ref={setPickerBox}
              request={asking}
            />
          )}
        </div>
      </div>
    </section>
  );
};

/**
 * Whether focus is anywhere in this window, page or chrome.
 *
 * The engine fork makes a `<webview>` with a focused guest the document's
 * `activeElement`, so page focus counts. `frame` is `null` before the ref
 * attaches.
 */
const holdsFocus = (frame: HTMLElement | null): boolean =>
  frame?.contains(document.activeElement) === true;

/**
 * Blurs the focused element if it is in this window.
 *
 * Blurring returns focus to the document, where the engine listens for keys
 * to forward to clients. Blink's `Element::blur` also moves the browser
 * process's focused frame off the guest.
 */
const releaseFocus = (frame: HTMLElement | null): void => {
  const held = document.activeElement;
  if (holdsFocus(frame) && held instanceof HTMLElement) {
    held.blur();
  }
};

const browserStyles = flex({
  // Unlike a client surface, a page needs a background, and `windowStyles`
  // sets none.
  backgroundColor: "background",
  direction: "column",
  // Clips the page to the frame's rounded bottom corners.
  overflow: "hidden",
});

/**
 * Fills the window. Kept upright about its top left corner while the window
 * eases, as the engine keeps a frame the page has not redrawn yet
 * (`resizing`).
 */
const contentsStyles = flex({
  blockSize: "full",
  direction: "column",
  flexShrink: 0,
  inlineSize: "full",
  transformOrigin: "0 0",
});

// Fills the height below the address bar and positions the overlays.
// How long the zoom popup stays up: briefly, as in Chrome, since the page
// shows the zoom.
const ZOOM_POPUP_MS = 2000;

const pageStyles = flex({
  direction: "column",
  flex: 1,
  minBlockSize: 0,
  minInlineSize: 0,
  position: "relative",
});

// At the top of the page, where Chrome's chooser hangs from its address bar.
const deviceAskStyles = css({
  borderRadius: "lg",
  boxShadow: "lifted",
  inlineSize: 88,
  insetBlockStart: 2,
  insetInlineStart: "50%",
  maxInlineSize: "calc(100% - {spacing.4})",
  position: "absolute",
  transform: "translateX(-50%)",
});

// A `<webview>` is a replaced element with a 300x150 intrinsic size, so it
// must be stretched. `min-block-size: 0` lets it shrink below that size so
// the page does not overflow the window. `display` is unset because flex items
// are blockified anyway.
const viewStyles = css({
  borderStyle: "none",
  flex: 1,
  minBlockSize: 0,
  minInlineSize: 0,
});

// The title bar draws the top edge.
const noTopEdgeStyles = css({ borderBlockStartWidth: 0 });

/**
 * The address bar's URL: the page's URL, or the pending one before the first
 * commit.
 *
 * Avoids a blank bar during navigation. The security indicator still comes
 * from the browser, so a pending URL shows no lock.
 */
const addressOf = (shown: string, sent: string): string =>
  shown === "" ? sent : shown;
