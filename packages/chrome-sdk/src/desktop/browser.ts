// The desk's browser windows, which the browser holds and a shell draws with
// `<webview window="id">`, and fetches with the browser's cookies.

import type {
  DomicileBrowserProfile,
  DomicileBrowserWindow,
  DomicileFetchHeader,
  DomicileFetchResponse,
  DomicileHost,
} from "../domicile-host";
import type { Defined } from "./defined";
import { defined } from "./defined";
import { memoizeLast } from "./memoize-last";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";

export type BrowserWindow = Defined<DomicileBrowserWindow>;

/**
 * One of the desk's browser profiles: a set of sign-ins, site data and
 * extensions, as the config's `browser.profiles` names it.
 */
export type BrowserProfile = DomicileBrowserProfile;

/** How {@link Browser.open} opens its window. */
export type BrowserWindowOptions = {
  /** Storage of the window's own, as a `<webview>`'s `partition` has. */
  partition?: string;
  /**
   * The id of the browser profile to open it in, one of
   * {@link Browser.profiles}. By default, the profile its site opens in
   * ({@link Browser.profileFor}).
   */
  profile?: string;
};

export type FetchHeader = DomicileFetchHeader;
export type FetchResponse = DomicileFetchResponse;

/** A fetch with the cookies of a browser profile. */
export type FetchInit = {
  /** `GET` by default. */
  method?: "GET" | "POST";
  headers?: readonly FetchHeader[];
  /** A POST's body. */
  body?: string;
  /**
   * An https origin to send Google's `Authorization: SAPISIDHASH` header for,
   * computed from the SAPISID cookie the page never sees.
   */
  sapisidHashOrigin?: string;
  /**
   * The id of the browser profile whose cookies to send, one of
   * {@link Browser.profiles}; the default profile's by default. A private
   * profile keeps none to send, and is refused.
   */
  profile?: string;
};

/** What {@link Browser.openApp} does when an app window with its id is open. */
export enum AppReuse {
  /** Opens another window. */
  New,
  /** Brings the open one to the front, as its page's window.focus() would. */
  Focus,
  /** Loads the address in the open one and brings it to the front. */
  Navigate,
}

/** How {@link Browser.openApp} opens its window. */
export type AppWindowOptions = {
  /**
   * The app the window belongs to, such as `mail:me@example.com`. Listed as
   * the window's `appId`.
   */
  id?: string;
  /** {@link AppReuse.New} by default. Any other needs an `id`. */
  reuse?: AppReuse;
  /**
   * The id of the browser profile a new window opens in, one of
   * {@link Browser.profiles}. By default, the profile its site opens in.
   */
  profile?: string;
};

export type BrowserListeners = {
  /** A window opened, closed or changed. */
  change: () => void;
  /**
   * A profile was added, removed, renamed or recolored, the defaults moved, a
   * site was pinned, or an extension was installed, uninstalled or switched
   * in one.
   */
  profilesChange: () => void;
};

export type Browser = {
  /**
   * The desk's browser windows, oldest first; `undefined` until the browser
   * lists them. An Electron app's views are not windows, and are in
   * {@link Browser.views} instead.
   */
  readonly windows: readonly BrowserWindow[] | undefined;
  /**
   * An Electron app's views (`WebContentsView`): pages that are part of a
   * window, each with the `parent` window that holds it and where its app
   * asks for it (`x`, `y`, `width`, `height`). Bottom first within a window;
   * `undefined` until the browser lists them. Draw each with
   * `<webview window>` over or inside its window, where its app asks or
   * wherever your layout puts it. See docs/SHELL-BROWSER-WINDOWS.md.
   */
  readonly views: readonly BrowserWindow[] | undefined;
  /**
   * The desk's browser profiles, in the config's order; `undefined` until
   * the browser lists them.
   */
  readonly profiles: readonly BrowserProfile[] | undefined;
  /**
   * The id of the browser profile `url` opens in: the most specific of the
   * config's `browser.sites` that matches it, else the default profile.
   * Rejects with a TypeError for an invalid `url`.
   */
  profileFor: (url: string) => Promise<string>;
  /**
   * The site that routes `url` to its profile: the entry of the config's
   * `browser.sites`, or of a profile's {@link BrowserProfile.pinnedSites},
   * that {@link Browser.profileFor} matched. `undefined` when none did, so it
   * opens in the default profile. Rejects with a TypeError for an invalid
   * `url`.
   */
  siteFor: (url: string) => Promise<string | undefined>;
  /**
   * Open `site` in browser profile `profile` from now on, kept across
   * restarts; the default profile unpins it. `site` is a host, `*.host`, or a
   * host and path, as the config's `browser.sites` keys are. Pages already
   * open stay where they are. Rejects with an `OperationError` for a site one
   * of the config's sites names ({@link BrowserProfile.configSites}), which
   * only the config changes.
   */
  pin: (site: string, profile: string) => Promise<void>;
  /**
   * Switch extension `id` on or off in browser profile `profile`, kept
   * across restarts; it keeps its data while off. Rejects with an
   * `OperationError` for one in the profile's
   * {@link BrowserProfile.lockedExtensions}, which only the config switches.
   */
  setExtensionEnabled: (
    profile: string,
    id: string,
    enabled: boolean,
  ) => Promise<void>;
  /** Open a browser window, in the profile its site opens in by default. */
  open: (url: string, options?: BrowserWindowOptions) => void;
  /** Open a window in the default private profile. */
  openPrivate: (url: string) => void;
  /**
   * Move window `id`'s page to browser profile `profile` in place: the
   * window keeps its id and its history's addresses, and its page loads
   * again in the new profile. An unknown window or profile, or an app
   * window, stays as it is.
   */
  reopen: (id: string, profile: string) => void;
  /**
   * Open an app window, with no address bar, or reuse the oldest one with
   * `id` as `reuse` says. The browser matches the window, so two quick calls
   * never open two.
   */
  openApp: (url: string, options?: AppWindowOptions) => void;
  /**
   * How many elements in window `id`'s page match the CSS `selector`. A
   * hidden window answers. Rejects for an unknown window, and when the page
   * gave no number.
   */
  countMatches: (id: string, selector: string) => Promise<number>;
  /**
   * Click the first shown element in window `id`'s page that matches the CSS
   * `selector`, as a press of the mouse's main button on it does. The page
   * hears untrusted events. A hidden window is clicked too. Resolves whether an
   * element matched. Rejects for an unknown window, and when the page gave no
   * answer.
   */
  clickMatch: (id: string, selector: string) => Promise<boolean>;
  /** Close window `id`. Its page may ask to stay. */
  close: (id: string) => void;
  /**
   * The user clicked entry `command` (its `id`) of window `id`'s menu bar;
   * its Electron app runs the entry.
   */
  clickMenu: (id: string, command: number) => void;
  /**
   * The user chose entry `command` (its `id`) of the popup menu window `id`
   * shows (its `popupMenu`), or put it away with nothing chosen for 0; its
   * Electron app runs the entry.
   */
  answerPopupMenu: (id: string, command: number) => void;
  /**
   * The shell made window `id` `state`, whether or not its app asked (its
   * `wantsMaximized` and the rest). Its Electron app hears each change; any
   * other window ignores it.
   */
  setWindowState: (id: string, state: WindowStateReport) => void;
  /**
   * The user answered the message box window `id` shows (its `messageBox`)
   * with button `response`, an index into its `buttons`, leaving its checkbox
   * `checkboxChecked`; its Electron app hears the answer.
   */
  answerMessageBox: (
    id: string,
    response: number,
    checkboxChecked: boolean,
  ) => void;
  /**
   * Fetch `url` from the browser process with a browser profile's cookies.
   * Resolves whatever the status; rejects with a NetworkError for a refusal
   * or a network failure.
   */
  fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>;
  on: On<BrowserListeners>;
};

export type BrowserHost = Pick<
  DomicileHost,
  | "addEventListener"
  | "answerBrowserWindowMessageBox"
  | "answerBrowserWindowPopupMenu"
  | "browserProfileFor"
  | "browserProfiles"
  | "browserSiteFor"
  | "browserWindows"
  | "clickBrowserWindowMatch"
  | "clickBrowserWindowMenu"
  | "closeBrowserWindow"
  | "countBrowserWindowMatches"
  | "fetchWithCookies"
  | "openAppWindow"
  | "openBrowserWindow"
  | "openPrivateBrowserWindow"
  | "pinBrowserSite"
  | "removeEventListener"
  | "reopenBrowserWindow"
  | "setBrowserProfileExtensionEnabled"
  | "setBrowserWindowState"
>;

/** What the shell made a window, as `setWindowState` reports it. */
export type WindowStateReport = {
  readonly maximized: boolean;
  readonly minimized: boolean;
  readonly fullscreen: boolean;
};

export const browser = (host: BrowserHost): Browser => {
  const windowsOf = memoizeLast(
    (list: readonly DomicileBrowserWindow[] | null) =>
      list?.filter(({ parent }) => parent === null).map(defined),
  );
  const viewsOf = memoizeLast((list: readonly DomicileBrowserWindow[] | null) =>
    list?.filter(({ parent }) => parent !== null).map(defined),
  );
  return {
    answerMessageBox: (id, response, checkboxChecked) => {
      host.answerBrowserWindowMessageBox(id, response, checkboxChecked);
    },
    answerPopupMenu: (id, command) => {
      host.answerBrowserWindowPopupMenu(id, command);
    },
    clickMatch: (id, selector) => host.clickBrowserWindowMatch(id, selector),
    clickMenu: (id, command) => {
      host.clickBrowserWindowMenu(id, command);
    },
    close: (id) => {
      host.closeBrowserWindow(id);
    },
    countMatches: (id, selector) =>
      host.countBrowserWindowMatches(id, selector),
    fetch: (
      url,
      {
        method = "GET",
        headers = [],
        body,
        sapisidHashOrigin,
        profile = "",
      } = {},
    ) =>
      host.fetchWithCookies(
        url,
        method,
        headers,
        body ?? null,
        sapisidHashOrigin ?? null,
        profile,
      ),
    on: on<BrowserListeners>({
      change: (listener) =>
        hostEvent(host, "browserwindowschanged", () => listener()),
      profilesChange: (listener) =>
        hostEvent(host, "browserprofileschanged", () => listener()),
    }),
    open: (url, { partition = "", profile = "" } = {}) => {
      host.openBrowserWindow(url, partition, profile);
    },
    openApp: (url, { id = "", reuse = AppReuse.New, profile = "" } = {}) => {
      host.openAppWindow(url, id, reuseName(reuse), profile);
    },
    openPrivate: (url) => {
      host.openPrivateBrowserWindow(url);
    },
    pin: (site, profile) => host.pinBrowserSite(site, profile),
    profileFor: (url) => host.browserProfileFor(url),
    get profiles() {
      return host.browserProfiles ?? undefined;
    },
    reopen: (id, profile) => {
      host.reopenBrowserWindow(id, profile);
    },
    setExtensionEnabled: (profile, id, enabled) =>
      host.setBrowserProfileExtensionEnabled(profile, id, enabled),
    setWindowState: (id, { fullscreen, maximized, minimized }) => {
      host.setBrowserWindowState(id, maximized, minimized, fullscreen);
    },
    siteFor: async (url) => {
      const site = await host.browserSiteFor(url);
      return site === "" ? undefined : site;
    },
    get views() {
      return viewsOf(host.browserWindows);
    },
    get windows() {
      return windowsOf(host.browserWindows);
    },
  };
};

/** `reuse` as the engine's openAppWindow names it. */
const reuseName = (reuse: AppReuse): string => {
  switch (reuse) {
    case AppReuse.New:
      return "new";
    case AppReuse.Focus:
      return "focus";
    case AppReuse.Navigate:
      return "navigate";
  }
};
