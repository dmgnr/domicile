// A desktop for a shell's tests. The test sets state, which dispatches the
// engine's change events, and every call the shell makes is recorded.
//
// ```ts
// const fake = new FakeDomicileHost();
// render(<Desktop domicile={fake.domicile} />);
// fake.appear("term", { title: "Terminal" });
// fake.dispatch("shortcut", { chord: "Meta+Return" });
// expect(fake.calls).toContainEqual(["spawn", ["kitty"]]);
// ```

import { defined } from "./desktop/defined";
import type { Domicile } from "./desktop/desktop";
import { desktop } from "./desktop/desktop";
import type { ClientWindow } from "./desktop/windows";
import type {
  DomicileBrowserWindow,
  DomicileHost,
  DomicileHostEventMap,
  DomicileWindow,
} from "./domicile-host";

/** The attributes of the desktop a test sets. */
export type DomicileState = {
  -readonly [K in keyof DomicileHost as DomicileHost[K] extends (
    ...args: never[]
  ) => unknown
    ? never
    : K]: DomicileHost[K];
};

/** The event the engine dispatches when each attribute changes. */
const CHANGED: Readonly<
  Record<keyof DomicileState, keyof DomicileHostEventMap>
> = {
  accentColor: "appearancechanged",
  altKey: "modifierschanged",
  browserProfiles: "browserprofileschanged",
  browserWindows: "browserwindowschanged",
  castSinks: "castsinkschanged",
  clipboard: "clipboardchanged",
  ctrlKey: "modifierschanged",
  displays: "displayschanged",
  downloads: "downloadschanged",
  extensions: "extensionschanged",
  focusedWindow: "focusedwindowchanged",
  highContrast: "appearancechanged",
  idle: "idlechanged",
  installedExtensions: "installedextensionschanged",
  locked: "lockedchanged",
  metaKey: "modifierschanged",
  notifications: "notificationschanged",
  pictureInPictureVideos: "pictureinpicturevideoschanged",
  reducedMotion: "appearancechanged",
  shellOptions: "shelloptionschanged",
  shiftKey: "modifierschanged",
  theme: "themechanged",
  tray: "traychanged",
  windows: "windowschanged",
  windowsTheme: "windowsthemechanged",
};

/** Every attribute before the compositor has sent anything. */
const UNDESCRIBED: DomicileState = {
  accentColor: null,
  altKey: null,
  browserProfiles: null,
  browserWindows: null,
  castSinks: null,
  clipboard: null,
  ctrlKey: null,
  displays: null,
  downloads: null,
  extensions: null,
  focusedWindow: null,
  highContrast: null,
  idle: null,
  installedExtensions: null,
  locked: null,
  metaKey: null,
  notifications: null,
  pictureInPictureVideos: null,
  reducedMotion: null,
  shellOptions: null,
  shiftKey: null,
  theme: null,
  tray: null,
  windows: [],
  windowsTheme: null,
};

/** {@link describedWindow} as `Domicile.windows.list` reads it. */
export const listedWindow = (
  appId: string,
  fields: Partial<ClientWindow> = {},
): ClientWindow => ({ ...defined(describedWindow(appId)), ...fields });

/** A window as the engine lists it before its client has sent anything. */
export const describedWindow = (
  appId: string,
  fields: Partial<DomicileWindow> = {},
): DomicileWindow => ({
  anchor: null,
  appId,
  clientFrame: false,
  cursor: "default",
  cursorImage: null,
  desktopId: "",
  dialog: false,
  frame: 0,
  gid: null,
  grab: false,
  height: null,
  inhibitsShortcuts: false,
  maxHeight: null,
  maxWidth: null,
  minHeight: null,
  minWidth: null,
  parent: null,
  pid: null,
  pidfdInode: null,
  pointerConstraint: null,
  pointerRegion: null,
  sandboxAppId: null,
  sandboxEngine: null,
  sandboxed: null,
  sandboxInstanceId: null,
  title: "",
  toplevelId: null,
  transientFor: null,
  uid: null,
  urgent: false,
  width: null,
  x: null,
  y: null,
  ...fields,
});

/** Whether rank `a` sorts after `b`, part by part. An empty `b` is none. */
const moreSpecific = (a: readonly number[], b: readonly number[]): boolean => {
  for (const [index, part] of a.entries()) {
    const other = b[index];
    if (other === undefined || part !== other) {
      return other === undefined || part > other;
    }
  }
  return false;
};

/** The methods that return a promise. The fake's never settle. */
const ASKS = new Set([
  "browserProfileFor",
  "clickBrowserWindowMatch",
  "configureExtension",
  "confinePointer",
  "countBrowserWindowMatches",
  "fetchWithCookies",
  "searchFiles",
  "setExtensionEnabled",
  "startCasting",
  "uninstallExtension",
]);

export class FakeDomicileHost {
  /** Every call the shell made, in order: the method's name, then its arguments. */
  readonly calls: (readonly [method: string, ...args: unknown[]])[] = [];

  /** The raw host the engine draws the desktop from. */
  readonly host: DomicileHost;

  /** What the shell is handed as its desktop: {@link desktop} of `host`. */
  get domicile(): Domicile {
    return desktop(this.host);
  }

  readonly #target = new EventTarget();
  readonly #state: DomicileState = { ...UNDESCRIBED };
  #browsersOpened = 0;

  constructor() {
    const target = this.#target;
    const state = this.#state;
    const calls = this.calls;
    this.host = new Proxy({} as DomicileHost, {
      get: (_, name) => {
        if (typeof name !== "string") {
          return undefined;
        } else if (Object.hasOwn(state, name)) {
          return state[name as keyof DomicileState];
        } else if (name === "openBrowserWindow") {
          return (...args: Parameters<DomicileHost["openBrowserWindow"]>) => {
            calls.push([name, ...args]);
            const [url, partition = "", profile = ""] = args;
            this.openBrowser(url, {
              partition,
              ...(profile === "" ? {} : { profile }),
            });
          };
        } else if (name === "openPrivateBrowserWindow") {
          return (url: string) => {
            calls.push([name, url]);
            this.openBrowser(url, { isPrivate: true });
          };
        } else if (name === "openAppWindow") {
          return (...args: Parameters<DomicileHost["openAppWindow"]>) => {
            calls.push([name, ...args]);
            const [url, appId = "", reuse = "new", profile = ""] = args;
            this.openApp(url, appId, reuse, profile);
          };
        } else if (name === "browserSiteFor") {
          return (url: string) => {
            calls.push([name, url]);
            return Promise.resolve(this.siteFor(url));
          };
        } else if (name === "pinBrowserSite") {
          return (site: string, profile: string) => {
            calls.push([name, site, profile]);
            return this.pin(site, profile);
          };
        } else if (name === "setBrowserProfileExtensionEnabled") {
          return (profile: string, id: string, enabled: boolean) => {
            calls.push([name, profile, id, enabled]);
            return this.switchExtension(profile, id, enabled);
          };
        } else if (name === "reopenBrowserWindow") {
          return (id: string, profile: string) => {
            calls.push([name, id, profile]);
            this.moveBrowser(id, profile);
          };
        } else if (name === "closeBrowserWindow") {
          return (id: string) => {
            calls.push([name, id]);
            this.closeBrowser(id);
          };
        } else if (
          name === "addEventListener" ||
          name === "removeEventListener" ||
          name === "dispatchEvent"
        ) {
          return target[name].bind(target);
        } else {
          return (...args: unknown[]) => {
            calls.push([name, ...args]);
            return ASKS.has(name) ? new Promise(() => undefined) : undefined;
          };
        }
      },
      has: (_, name) => typeof name === "string",
    });
  }

  /** Set attributes, then dispatch each change event they owe, once. */
  set(changes: Partial<DomicileState>): void {
    Object.assign(this.#state, changes);
    for (const type of new Set(
      Object.keys(changes).map((name) => CHANGED[name as keyof DomicileState]),
    )) {
      this.#target.dispatchEvent(new Event(type));
    }
  }

  /** A window appeared: the end of `windows`. */
  appear(appId: string, fields: Partial<DomicileWindow> = {}): void {
    this.set({
      windows: [
        ...this.#state.windows.filter((window) => window.appId !== appId),
        describedWindow(appId, fields),
      ],
    });
  }

  /** What the compositor says of a window that is open. */
  change(appId: string, fields: Partial<DomicileWindow>): void {
    this.set({
      windows: this.#state.windows.map((window) =>
        window.appId === appId ? { ...window, ...fields } : window,
      ),
    });
  }

  /** A window closed. */
  close(appId: string): void {
    this.set({
      windows: this.#state.windows.filter((window) => window.appId !== appId),
    });
  }

  /**
   * The engine opened a browser window at `url`, as for `domicile open`,
   * `target="_blank"`, with `popupWindow` an extension's popup window, or with
   * `isApp` `domicile open --app`. `openBrowserWindow` calls this too, and
   * `openPrivateBrowserWindow` with `isPrivate`, and `openApp` with `isApp`
   * and `appId`. Ids count up from `"1"`; the asked-for size is 0 unless
   * `width` and `height` give one. With a `parent`, it is an Electron app's
   * view in that window, at `x` and `y`. It is in `profile`, or as the
   * engine picks: none for an app window (an app module's or Electron
   * app's; `openApp` names one), else the default private profile
   * when `isPrivate` and the default one otherwise, from `browserProfiles`
   * or the config's own `default` and `private`.
   */
  openBrowser(
    url: string,
    {
      appId = "",
      isApp = false,
      isHidden = false,
      isPrivate = false,
      parent = null,
      partition = "",
      popupWindow = null,
      profile,
      width = 0,
      height = 0,
      x = 0,
      y = 0,
    }: Partial<
      Pick<
        DomicileBrowserWindow,
        | "appId"
        | "height"
        | "isApp"
        | "isHidden"
        | "isPrivate"
        | "parent"
        | "partition"
        | "popupWindow"
        | "profile"
        | "width"
        | "x"
        | "y"
      >
    > = {},
  ): void {
    this.#browsersOpened += 1;
    const profiles = this.#state.browserProfiles ?? [];
    const fallback = isPrivate
      ? (profiles.find((each) => each.isDefaultPrivate)?.id ?? "private")
      : (profiles.find((each) => each.isDefault)?.id ?? "default");
    this.set({
      browserWindows: [
        ...(this.#state.browserWindows ?? []),
        {
          appId,
          height,
          id: this.#browsersOpened.toString(),
          isApp,
          isCaptured: false,
          isHidden,
          isPrivate,
          menu: null,
          menuBarAutoHide: false,
          menuBarVisible: true,
          messageBox: null,
          parent,
          partition,
          popupMenu: null,
          popupWindow,
          profile: profile ?? (isApp ? null : fallback),
          title: "",
          toplevelId: null,
          url,
          wantsFullscreen: false,
          wantsMaximized: false,
          wantsMinimized: false,
          width,
          x,
          y,
        } satisfies DomicileBrowserWindow,
      ],
    });
  }

  /**
   * `openAppWindow`, as the engine carries it out: reuses the oldest app
   * window with `appId` unless `reuse` is "new", loading `url` in it for
   * "navigate", and otherwise opens one.
   */
  openApp(url: string, appId: string, reuse: string, profile = ""): void {
    const windows = this.#state.browserWindows ?? [];
    const open =
      appId === "" || reuse === "new"
        ? undefined
        : windows.find((window) => window.appId === appId);
    if (open === undefined) {
      // A site's app window is in a profile, as a browser window is: the
      // fake routes no site, so the default one when none is named.
      this.openBrowser(url, {
        appId,
        isApp: true,
        profile:
          profile === ""
            ? ((this.#state.browserProfiles ?? []).find(
                (each) => each.isDefault,
              )?.id ?? "default")
            : profile,
      });
    } else if (reuse === "navigate") {
      this.set({
        browserWindows: windows.map((window) =>
          window === open ? { ...window, url } : window,
        ),
      });
    }
  }

  /**
   * A capture of browser window `id`'s page alone started, or with `captured`
   * false ended, as the engine lists it.
   */
  captureBrowser(id: string, captured = true): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id ? { ...window, isCaptured: captured } : window,
      ),
    });
  }

  /**
   * Browser window `id`'s Electron app set its menu bar: `menu` as the engine
   * lists it (JSON entries), or null for none.
   */
  setMenuBar(
    id: string,
    menu: string | null,
    { autoHide = false, visible = true } = {},
  ): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id
          ? {
              ...window,
              menu,
              menuBarAutoHide: autoHide,
              menuBarVisible: visible,
            }
          : window,
      ),
    });
  }

  /**
   * Browser window `id` shows its Electron app's popup menu `menu`, as the
   * engine lists it (JSON), or null for none.
   */
  /**
   * Browser window `id`'s Electron app asks to be maximized, minimized or
   * fullscreen, as the engine lists it.
   */
  setWantedState(
    id: string,
    wants: Partial<
      Pick<
        DomicileBrowserWindow,
        "wantsFullscreen" | "wantsMaximized" | "wantsMinimized"
      >
    >,
  ): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id ? { ...window, ...wants } : window,
      ),
    });
  }

  /**
   * Browser window `id` shows its Electron app's popup menu `menu`, as the
   * engine lists it (JSON), or null for none.
   */
  setPopupMenu(id: string, menu: string | null): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id ? { ...window, popupMenu: menu } : window,
      ),
    });
  }

  /**
   * Browser window `id` shows its Electron app's message box `box`, as the
   * engine lists it (JSON), or null for none.
   */
  setMessageBox(id: string, box: string | null): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id ? { ...window, messageBox: box } : window,
      ),
    });
  }

  /**
   * The engine moved browser window `id`'s page to browser profile `profile`,
   * as for a link to another profile's site. `reopenBrowserWindow` calls this
   * too.
   */
  moveBrowser(id: string, profile: string): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).map((window) =>
        window.id === id ? { ...window, profile } : window,
      ),
    });
  }

  /**
   * The site of `browserProfiles`' sites that routes `url`, as the engine's
   * `browserSiteFor` matches it: the most specific, a path over a host and a
   * host over `*.host`. Empty for none.
   */
  siteFor(url: string): string {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      return "";
    }
    if (address.protocol !== "http:" && address.protocol !== "https:") {
      return "";
    }
    const sites = (this.#state.browserProfiles ?? []).flatMap((profile) => [
      ...profile.pinnedSites,
      ...profile.configSites,
    ]);
    const rank = (site: string): number[] | undefined => {
      const slash = site.indexOf("/");
      const host = slash === -1 ? site : site.slice(0, slash);
      const path = slash === -1 ? "" : site.slice(slash);
      const wildcard = host.startsWith("*.");
      const parent = wildcard ? host.slice(2) : host;
      const hostMatches = wildcard
        ? address.hostname === parent || address.hostname.endsWith(`.${parent}`)
        : address.hostname === host;
      const pathMatches =
        path === "" ||
        address.pathname === path ||
        address.pathname.startsWith(`${path}/`);
      return hostMatches && pathMatches
        ? [path.split("/").length, wildcard ? 0 : 1, host.length]
        : undefined;
    };
    let best = "";
    let bestRank: number[] = [];
    for (const site of sites) {
      const ranked = rank(site);
      if (ranked !== undefined && moreSpecific(ranked, bestRank)) {
        best = site;
        bestRank = ranked;
      }
    }
    return best;
  }

  /**
   * Pins `site` to profile `id`, as the engine's `pinBrowserSite` does: out of
   * every profile's `pinnedSites`, then into `id`'s unless it is the default.
   * Rejects as the engine does for one of the config's sites.
   */
  pin(site: string, id: string): Promise<void> {
    const profiles = this.#state.browserProfiles ?? [];
    if (profiles.some((profile) => profile.configSites.includes(site))) {
      return Promise.reject(
        new DOMException(
          `the desk's config opens ${site}; only the config changes that`,
          "OperationError",
        ),
      );
    }
    this.set({
      browserProfiles: profiles.map((profile) => {
        const others = profile.pinnedSites.filter((each) => each !== site);
        return {
          ...profile,
          pinnedSites:
            profile.id === id && !profile.isDefault
              ? [...others, site]
              : others,
        };
      }),
    });
    return Promise.resolve();
  }

  /**
   * Switches extension `id` in profile `profile`, as the engine's
   * `setBrowserProfileExtensionEnabled` does. Rejects as the engine does for
   * one the profile does not have, or one in its `lockedExtensions`.
   */
  switchExtension(
    profile: string,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    const profiles = this.#state.browserProfiles ?? [];
    const found = profiles.find((each) => each.id === profile);
    if (found === undefined || !found.extensions.includes(id)) {
      return Promise.reject(
        new DOMException(`no extension ${id} is installed`, "OperationError"),
      );
    }
    if (found.lockedExtensions.includes(id)) {
      return Promise.reject(
        new DOMException("only the config switches this one", "OperationError"),
      );
    }
    this.set({
      browserProfiles: profiles.map((each) =>
        each.id === profile
          ? {
              ...each,
              enabledExtensions: enabled
                ? [...each.enabledExtensions.filter((on) => on !== id), id]
                : each.enabledExtensions.filter((on) => on !== id),
            }
          : each,
      ),
    });
    return Promise.resolve();
  }

  /** The engine closed browser window `id`. `closeBrowserWindow` calls this too. */
  closeBrowser(id: string): void {
    this.set({
      browserWindows: (this.#state.browserWindows ?? []).filter(
        (window) => window.id !== id,
      ),
    });
  }

  /** Dispatch a moment, such as `shortcut` or `focusrequested`, with its fields. */
  dispatch<T extends keyof DomicileHostEventMap>(
    type: T,
    fields: Partial<Omit<DomicileHostEventMap[T], keyof Event>> = {},
  ): void {
    this.#target.dispatchEvent(Object.assign(new Event(type), fields));
  }
}
