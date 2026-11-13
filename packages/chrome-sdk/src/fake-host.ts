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
  sandboxAppId: null,
  sandboxEngine: null,
  sandboxed: null,
  sandboxInstanceId: null,
  title: "",
  transientFor: null,
  uid: null,
  urgent: false,
  width: null,
  x: null,
  y: null,
  ...fields,
});

/** The methods that return a promise. The fake's never settle. */
const ASKS = new Set([
  "countBrowserWindowMatches",
  "fetchWithCookies",
  "searchFiles",
  "startCasting",
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
            const [url, partition = ""] = args;
            this.openBrowser(url, { partition });
          };
        } else if (name === "openPrivateBrowserWindow") {
          return (url: string) => {
            calls.push([name, url]);
            this.openBrowser(url, { isPrivate: true });
          };
        } else if (name === "openAppWindow") {
          return (...args: Parameters<DomicileHost["openAppWindow"]>) => {
            calls.push([name, ...args]);
            const [url, appId = "", reuse = "new"] = args;
            this.openApp(url, appId, reuse);
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
   * `width` and `height` give one.
   */
  openBrowser(
    url: string,
    {
      appId = "",
      isApp = false,
      isPrivate = false,
      partition = "",
      popupWindow = null,
      width = 0,
      height = 0,
    }: Partial<
      Pick<
        DomicileBrowserWindow,
        | "appId"
        | "height"
        | "isApp"
        | "isPrivate"
        | "partition"
        | "popupWindow"
        | "width"
      >
    > = {},
  ): void {
    this.#browsersOpened += 1;
    this.set({
      browserWindows: [
        ...(this.#state.browserWindows ?? []),
        {
          appId,
          height,
          id: this.#browsersOpened.toString(),
          isApp,
          isCaptured: false,
          isPrivate,
          partition,
          popupWindow,
          title: "",
          url,
          width,
        } satisfies DomicileBrowserWindow,
      ],
    });
  }

  /**
   * `openAppWindow`, as the engine carries it out: reuses the oldest app
   * window with `appId` unless `reuse` is "new", loading `url` in it for
   * "navigate", and otherwise opens one.
   */
  openApp(url: string, appId: string, reuse: string): void {
    const windows = this.#state.browserWindows ?? [];
    const open =
      appId === "" || reuse === "new"
        ? undefined
        : windows.find((window) => window.appId === appId);
    if (open === undefined) {
      this.openBrowser(url, { appId, isApp: true });
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
