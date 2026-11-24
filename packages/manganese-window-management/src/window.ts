// A window the shell holds: a Wayland client the host announced or a browser
// window the engine listed. The shell tiles and floats both, but the client or
// the engine opens and closes them. They share one id space and one title.

import type { CursorShape } from "@domicile-desktop/sdk/cursor-shape";

/** The prefix {@link appWindowId} namespaces a client's window with. */
const APP_PREFIX = "app:";

/** The prefix {@link browserWindowId} namespaces a browser window with. */
const BROWSER_PREFIX = "browser:";

/** The name of a browser window with no address yet. */
const BLANK_PAGE = "about:blank";

/**
 * Where a new browser window opens, from the bar's `+` or the sway launcher
 * key.
 */
export const HOME_PAGE = "https://www.google.com";

/** Which kind of window a {@link ShellWindow} is. */
export enum WindowKind {
  App,
  Browser,
}

/**
 * A Wayland client's window, as the shell holds it.
 *
 * The cursor is stored here because a window's element can unmount and
 * remount, and must get the current cursor back when it does.
 */
export type ClientWindow = {
  appId: string;
  /** The cursor the client asked for, or `undefined` if none. */
  cursor: CursorShape | undefined;
  /**
   * The CSS cursor for an image the client drew itself, shown in place of
   * `cursor`, or `undefined` while it uses a named one.
   */
  cursorImage: string | undefined;
  /**
   * The client's Wayland app id, which names its desktop entry and so its
   * icon. `""` until the client sets one.
   */
  desktopId: string;
  id: string;
  kind: WindowKind.App;
  /** The largest the client will draw its window. */
  maxSize: SizeLimit;
  /** The smallest the client will draw its window. */
  minSize: SizeLimit;
  /** The synced frame its `<app>` shows. See `DomicileWindow.frame`. */
  syncedFrame: number;
  title: string;
};

/**
 * A client's size limit per axis, in layout pixels. `undefined` means no
 * limit.
 */
export type SizeLimit = readonly [
  width: number | undefined,
  height: number | undefined,
];

/** No limit on either axis; the initial value for every window. */
export const UNLIMITED: SizeLimit = [undefined, undefined];

export const ShellWindow = {
  /**
   * A Wayland client's window. `id` is namespaced so it cannot collide with a
   * browser window's.
   */
  App: (appId: string, title: string): ClientWindow => ({
    appId,
    cursor: undefined,
    cursorImage: undefined,
    desktopId: "",
    id: appWindowId(appId),
    kind: WindowKind.App,
    maxSize: UNLIMITED,
    minSize: UNLIMITED,
    syncedFrame: 0,
    title,
  }),

  /**
   * A browser window from the engine's list.
   *
   * - `windowId`: the engine's id, for `<webview window>`. `id` prefixes it.
   * - `url`: the page's current address.
   * - `pageTitle`: the page's title, or `""` when it has none. Names the
   *   window; a page with none is named after its site.
   * - `popupWindow`: the `chrome.windows` id of the extension popup window
   *   whose one tab this is. Drawn without an address bar, as in Chrome.
   * - `isPrivate`: whether the page is private. Its address bar says so.
   * - `isApp`: whether this is an app window (`domicile open --app`). Drawn
   *   without an address bar.
   * - `appId`: the app window's id, its app's desktop id; `""` for none. An
   *   app window draws its app's icon over its page's.
   * - `isHidden`: whether its Electron app hid it. It stays open, its page
   *   running, on no workspace until the app shows it again.
   */
  Browser: (
    windowId: string,
    url: string,
    pageTitle: string,
    popupWindow: number | undefined,
    isPrivate: boolean,
    isApp: boolean,
    appId = "",
    isHidden = false,
  ) => ({
    appId,
    /**
     * The page's description, or `undefined` for none. The view reports it,
     * as it does the icon.
     */
    description: undefined as string | undefined,
    /**
     * The page's icon URL, or `undefined` for none. The view reports it, not
     * the engine's list; see `BrowserIconChanged` in `window-state.ts`.
     */
    icon: undefined as string | undefined,
    id: browserWindowId(windowId),
    isApp,
    isHidden,
    isPrivate,
    kind: WindowKind.Browser as const,
    popupWindow,
    title: pageTitle === "" ? untitledName(url) : pageTitle,
    url,
  }),
};

export type ShellWindow = ReturnType<
  (typeof ShellWindow)[keyof typeof ShellWindow]
>;

/**
 * The window id for a host client, usable without building a window.
 */
export const appWindowId = (appId: string): string => `${APP_PREFIX}${appId}`;

/**
 * The inverse of {@link appWindowId}: the client's app id, or `undefined` for
 * a window the shell opened itself.
 */
export const appIdOf = (id: string): string | undefined =>
  id.startsWith(APP_PREFIX) ? id.slice(APP_PREFIX.length) : undefined;

/** Returns the window id for a browser window the engine listed. */
export const browserWindowId = (windowId: string): string =>
  `${BROWSER_PREFIX}${windowId}`;

/**
 * Returns the engine's browser window id behind a window id, or `undefined`
 * for a client's window. Closing a window asks the engine to close this id.
 */
export const browserIdOf = (id: string): string | undefined =>
  id.startsWith(BROWSER_PREFIX) ? id.slice(BROWSER_PREFIX.length) : undefined;

/**
 * A window's title: the host of the URL it shows, or the whole URL when it has
 * no host (such as `about:blank` or `data:` URLs a page navigates to).
 */
export const siteOf = (url: string): string => {
  const { hostname } = new URL(url);
  return hostname === "" ? url : hostname;
};

/** The name of a page with no title: its site, or a blank page's name. */
const untitledName = (url: string): string =>
  url === "" ? BLANK_PAGE : siteOf(url);
