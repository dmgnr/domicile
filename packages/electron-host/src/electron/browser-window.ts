// The stand-ins for Electron's `BrowserWindow`, `WebContentsView` and
// `BrowserView`. Each window is an app window on the desk, opened over the
// engine's Electron socket. Each view is a page the shell draws as part of the
// window that holds it. See "Windows" in docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EditCommand,
  Engine,
  EngineRequest,
  OpenKeys,
  PageNode,
  PageState,
  RestoredHistory,
  ViewPlacement,
  WindowEvent,
  WireFrame,
} from "../engine";
import { Priority, say } from "../journal";
import type { ElectronApp } from "./app";
import type { ContextMenuAsked } from "./context-menu";
import { contextMenuParams } from "./context-menu";
import { createFrames, SubFrame } from "./frames";
import type { createIpcMain } from "./ipc-main";
import { IpcMain } from "./ipc-main";
import type { MenuEntry } from "./menu";
import type { MessagePortMain } from "./message-port-main";
import { createPagePorts } from "./message-port-main";
import {
  ASKS_BEFORE_NAVIGATING,
  asksBeforeNavigating,
  takeNavigation,
} from "./navigation";
import type {
  DevToolsEvents,
  PageMethod,
  PrintToPdfOptions,
} from "./page-control";
import { createPageControl } from "./page-control";
import { isPageEvent, PageEvents } from "./page-events";
import type { createSessions, Session } from "./session";
import {
  followNetworkEmulation,
  framePreloadsOf,
  sessionPartition,
} from "./session";

type PageControl = ReturnType<typeof createPageControl>;

export type WebPreferences = {
  readonly preload?: string | undefined;
  /** Electron's partition string; the app's own session when left out. */
  readonly partition?: string | undefined;
  readonly session?: Session | undefined;
  readonly nodeIntegration?: boolean | undefined;
  readonly contextIsolation?: boolean | undefined;
  /** Left out, a page is sandboxed unless it asks for nodeIntegration. */
  readonly sandbox?: boolean | undefined;
  /** Added to the page's renderer's command line: its process.argv. */
  readonly additionalArguments?: readonly string[] | undefined;
  /** Whether the webContents hears preferred-size-changed. */
  readonly enablePreferredSizeMode?: boolean | undefined;
};

/** The requests about a page's contents, which its window's number completes. */
type PageRequest =
  Extract<
    EngineRequest,
    { type: "edit" | "replace" | "find_in_page" | "stop_find_in_page" }
  > extends infer Request
    ? Request extends unknown
      ? Omit<Request, "window">
      : never
    : never;

/** webContents.setZoomMode's modes. */
const ZOOM_MODES = ["default", "isolated", "manual", "disabled"] as const;
type ZoomMode = (typeof ZOOM_MODES)[number];

/** webContents.findInPage's options, as Electron's. */
export type FindOptions = {
  readonly forward?: boolean | undefined;
  readonly findNext?: boolean | undefined;
  readonly matchCase?: boolean | undefined;
};

/** What webContents.stopFindInPage does with the match, by its wire names. */
const STOP_FIND_ACTIONS = {
  activateSelection: "activate_selection",
  clearSelection: "clear_selection",
  keepSelection: "keep_selection",
} as const;

export type StopFindAction = keyof typeof STOP_FIND_ACTIONS;

/** A search's last answer, as the engine says it. */
type FoundInPage = Extract<WindowEvent, { type: "found_in_page" }>;

/** What every page with Node.js gets alike: the app's, not the window's. */
export type PageNodeBase = Pick<PageNode, "env">;

/** The host's own, which its app's pages get, as Electron's renderers do. */
const hostNodeBase = (): PageNodeBase => ({
  env: Object.fromEntries(
    // biome-ignore lint/style/noProcessEnv: the app's environment, which Electron's renderers inherit
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
});

export type BrowserWindowOptions = {
  readonly show?: boolean | undefined;
  /** It asks to be fullscreen once it opens. */
  readonly fullscreen?: boolean | undefined;
  /** Whether `setFullScreen` can make it fullscreen; true unless false. */
  readonly fullscreenable?: boolean | undefined;
  /** The menu bar hides until the user presses Alt. */
  readonly autoHideMenuBar?: boolean | undefined;
  readonly title?: string | undefined;
  /** The size it starts at, until the shell gives it one. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly webPreferences?: WebPreferences | undefined;
  /** The app's window this one belongs to: one of its BrowserWindows. */
  readonly parent?: unknown;
  /** With `parent`: the parent takes no input while this one shows. */
  readonly modal?: boolean | undefined;
};

/** A window's state, as the app asks it and the shell makes it. */
type WindowState = {
  readonly maximized: boolean;
  readonly minimized: boolean;
  readonly fullscreen: boolean;
};

const NORMAL: WindowState = {
  fullscreen: false,
  maximized: false,
  minimized: false,
};

/** Whether `a` and `b` are the same state. */
const sameState = (a: WindowState, b: WindowState) =>
  a.fullscreen === b.fullscreen &&
  a.maximized === b.maximized &&
  a.minimized === b.minimized;

/** What setWindowOpenHandler's handler is told of a page's new window. */
export type WindowOpenDetails = {
  readonly url: string;
  readonly frameName: string;
  readonly features: string;
  readonly disposition: string;
  readonly referrer: { readonly url: string; readonly policy: string };
  readonly postBody?: undefined;
};

/** What a window open handler answers, as Electron's does. */
export type WindowOpenAnswer =
  | { readonly action: "deny" }
  | {
      readonly action: "allow";
      readonly overrideBrowserWindowOptions?: BrowserWindowOptions | undefined;
      readonly outlivesOpener?: boolean | undefined;
      /** Makes the window itself: a new window's webContents, not yet loaded. */
      readonly createWindow?:
        | ((options: BrowserWindowOptions) => unknown)
        | undefined;
    };

/**
 * A new window's options: the opener's webPreferences, as Electron's child
 * windows inherit them, the size window.open asked for, and what the
 * handler overrides.
 */
export const childWindowOptions = (
  opener: WebPreferences,
  features: string,
  override: BrowserWindowOptions = {},
): BrowserWindowOptions => {
  const asked = new Map(
    features
      .split(",")
      .map((feature) => feature.split("=").map((part) => part.trim()))
      .filter(
        (pair): pair is [string, string] =>
          pair.length === 2 && Number.isFinite(Number(pair[1])),
      )
      .map(([name, value]) => [name, Number(value)] as const),
  );
  const width = asked.get("width");
  const height = asked.get("height");
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...override,
    webPreferences: { ...opener, ...override.webPreferences },
  };
};

export type ViewOptions = {
  readonly webPreferences?: WebPreferences | undefined;
};

/** Electron's `Rectangle`. */
export type Rectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** A `BrowserView`'s `setAutoResize`: what follows its window's size. */
export type AutoResize = {
  readonly width?: boolean | undefined;
  readonly height?: boolean | undefined;
  readonly horizontal?: boolean | undefined;
  readonly vertical?: boolean | undefined;
};

/** Where the windows' pages' IPC goes: the host's side of `ipcMain`. */
export type IpcRoutes = Pick<
  ReturnType<typeof createIpcMain>,
  "invoke" | "post" | "receive" | "sendSync"
>;

/** What a window's menu bar needs of the app's menus. */
export type WindowMenus<Menu> = {
  /** The app's menu, which a new window starts with. */
  readonly applicationMenu: () => Menu | null;
  /** The menu as the menu bar draws it. */
  readonly model: (menu: Menu) => readonly MenuEntry[];
  /** Carries out a click on entry `command` of window `window`'s `menu`. */
  readonly click: (menu: Menu, command: number, window: number) => void;
};

/** Electron's size for a window that asks for none. */
const DEFAULT_SIZE = { height: 600, width: 800 };

/** What this host has warned of, so each warning shows once. */
const warned = new Set<string>();
const warnOnce = (key: string, why: string) => {
  if (!warned.has(key)) {
    warned.add(key);
    // The app's log is where a stated answer is told.
    say(Priority.Warning, `electron-host: ${why}`);
  }
};

const NO_BOUNDS: Rectangle = { height: 0, width: 0, x: 0, y: 0 };

/**
 * One side of a BrowserView that follows its window: scaled with it, grown by
 * as much as it grew, or left.
 */
const followed = (
  size: number,
  scales: boolean | undefined,
  grows: boolean | undefined,
  growth: number,
  scale: number,
) => {
  if (scales) {
    return Math.round(size * scale);
  } else if (grows) {
    return size + growth;
  } else {
    return size;
  }
};

/**
 * Makes the `BrowserWindow`, `WebContentsView` and `BrowserView` classes for
 * an app on `engine`. The engine's window events reach the page they name, and
 * its pages' IPC reaches `ipc`. Its pages load through `sessions`. A window's
 * menu bar shows one of `menus`. `readPreload` reads a preload's source. `webContentsOf` finds a page by the
 * engine's number, a window's or a view's.
 */
export const createBrowserWindow = <Menu extends EventEmitter>(
  engine: Engine,
  app: ElectronApp,
  ipc: IpcRoutes,
  sessions: ReturnType<typeof createSessions>,
  menus: WindowMenus<Menu>,
  readPreload: (path: string) => string = (path) => readFileSync(path, "utf8"),
  /**
   * Gives up on an app whose page needs what the engine doesn't do yet. The
   * host exits with `UNSUPPORTED_EXIT`, so the app runs on its own Electron.
   */
  refuse: (why: string) => never = (why) => {
    throw new Error(why);
  },
  /** What its pages with Node.js get alike. */
  nodeBase: () => PageNodeBase = hostNodeBase,
) => {
  /** Every page by the engine's number: windows' and views'. */
  const pages = new Map<number, Page>();
  const windows = new Map<number, BrowserWindow>();
  /**
   * Sends `request` to the engine, unless it's for a page the engine hasn't
   * opened yet, which the engine would refuse: that is said and dropped.
   */
  /** The last few kinds of request each window was sent, for a refusal. */
  const sentTo = new Map<number, string[]>();
  const toEngine: Engine["send"] = (request) => {
    const page =
      "window" in request && request.type !== "open_window"
        ? pages.get(request.window as number)
        : undefined;
    if ("window" in request) {
      const kinds = sentTo.get(request.window as number) ?? [];
      sentTo.set(request.window as number, [...kinds.slice(-3), request.type]);
    }
    if (page !== undefined && !page.isOpen()) {
      warnOnce(
        `unopened ${request.type}`,
        `${app.getName()} sent ${request.type} to a window before loading it, which goes nowhere`,
      );
      return;
    }
    engine.send(request);
  };
  const ports = createPagePorts(toEngine);
  let nextId = 1;
  /** Numbers the app's executeJavaScript calls, across its pages. */
  let nextCall = 1;

  /** The event object Electron passes first to a window listener. */
  const eventObject = () => {
    const event = {
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    return event;
  };

  /**
   * Electron's `WebFrameMain` for a page's main frame. The engine runs the
   * app's scripts and IPC only in the main frame, so it has no others.
   */
  class WebFrameMain extends EventEmitter {
    /** The engine's ids for the frame, once a navigation event names them. */
    #ids: WireFrame | undefined;

    constructor(readonly page: Page) {
      super();
    }

    readonly identify = (frame: WireFrame) => {
      this.#ids = frame;
    };

    get ipc() {
      return this.page.webContents.ipc;
    }
    get url() {
      return this.page.url;
    }
    get origin() {
      return URL.canParse(this.page.url) ? new URL(this.page.url).origin : "";
    }
    get top() {
      return this;
    }
    get parent() {
      return null;
    }
    get frames() {
      return [];
    }
    get framesInSubtree() {
      return [this];
    }
    get detached() {
      return false;
    }
    get name() {
      return "";
    }
    get visibilityState() {
      return "visible";
    }
    // As the engine last said; nothing before its first word on the page.
    get routingId() {
      return (
        this.page.webContents.pageState()?.routing_id ?? this.#ids?.routing ?? 0
      );
    }
    get frameTreeNodeId() {
      return this.page.id;
    }
    get processId() {
      return (
        this.page.webContents.pageState()?.process_id ?? this.#ids?.process ?? 0
      );
    }
    get osProcessId() {
      return this.page.webContents.getOSProcessId();
    }
    get frameToken() {
      return this.page.webContents.pageState()?.frame_token ?? "";
    }
    readonly isDestroyed = () => this.page.isDestroyed();
    readonly executeJavaScript = (code: string, userGesture = false) =>
      this.page.runJavaScript(code, userGesture);
    readonly send = (channel: string, ...args: unknown[]) => {
      this.page.webContents.send(channel, ...args);
    };
    readonly postMessage = (
      channel: string,
      message: unknown,
      transfer: readonly MessagePortMain[] = [],
    ) => {
      this.page.webContents.postMessage(channel, message, transfer);
    };
    readonly printToPDF = (options: PrintToPdfOptions) =>
      this.page.webContents.printToPDF(options);
    readonly copyVideoFrameAt = (x: number, y: number) => {
      this.page.webContents.copyVideoFrameAt(x, y);
    };
    readonly reload = () => {
      // Electron's answers only whether the reload started.
      void this.page.webContents.reload().catch(() => undefined);
      return true;
    };
  }

  /** A page's `webContents`, as far as the host has it. */
  class WebContents extends EventEmitter {
    /** What this page alone sends, heard before `ipcMain`. */
    readonly ipc = new IpcMain();
    #mainFrame: WebFrameMain | undefined;
    /** What it hears of its page's console, sound, cursor and input. */
    readonly pageEvents: PageEvents;

    // What the engine carries out on the page with a page call
    // (page-control.ts), set as it is made.
    declare readonly reloadIgnoringCache: PageControl["reloadIgnoringCache"];
    declare readonly insertCSS: PageControl["insertCSS"];
    declare readonly removeInsertedCSS: PageControl["removeInsertedCSS"];
    declare readonly executeJavaScriptInIsolatedWorld: PageControl["executeJavaScriptInIsolatedWorld"];
    declare readonly capturePage: PageControl["capturePage"];
    declare readonly printToPDF: PageControl["printToPDF"];
    declare readonly copyImageAt: PageControl["copyImageAt"];
    declare readonly copyVideoFrameAt: PageControl["copyVideoFrameAt"];
    declare readonly adjustSelection: PageControl["adjustSelection"];
    declare readonly setCaretBrowsingEnabled: PageControl["setCaretBrowsingEnabled"];
    declare readonly isCaretBrowsingEnabled: PageControl["isCaretBrowsingEnabled"];
    declare readonly setWebRTCIPHandlingPolicy: PageControl["setWebRTCIPHandlingPolicy"];
    declare readonly getWebRTCIPHandlingPolicy: PageControl["getWebRTCIPHandlingPolicy"];
    declare readonly enableDeviceEmulation: PageControl["enableDeviceEmulation"];
    declare readonly disableDeviceEmulation: PageControl["disableDeviceEmulation"];
    declare readonly beginFrameSubscription: PageControl["beginFrameSubscription"];
    declare readonly endFrameSubscription: PageControl["endFrameSubscription"];

    constructor(readonly owner: Page) {
      super();
      Object.assign(this, createPageControl(owner));
      this.pageEvents = new PageEvents({
        contents: this,
        eventObject,
        isOpen: () => owner.isOpen(),
        preloadPath: () => owner.preferences.preload,
        send: (action) => toEngine({ ...action, window: owner.id }),
        sessionUserAgent: () => owner.session.getUserAgent(),
        window: () => (owner instanceof BrowserWindow ? owner : undefined),
      });
      this.#watchNavigationListeners();
    }

    /** Removes the app's listeners, and goes on hearing which it adds. */
    override removeAllListeners(name?: string | symbol) {
      // EventEmitter removes every event's only when given no name at all.
      if (name === undefined) {
        super.removeAllListeners();
      } else {
        super.removeAllListeners(name);
      }
      // Either may have taken this page's own newListener and removeListener.
      this.#watchNavigationListeners();
      this.pageEvents.watch();
      this.#tellListening(this.#listening());
      return this;
    }

    // EventEmitter says newListener before adding it, removeListener after.
    readonly #navigationListenerAdded = (name: string | symbol) => {
      if (asksBeforeNavigating(name)) {
        this.#tellListening(true);
      }
    };
    readonly #navigationListenerRemoved = (name: string | symbol) => {
      if (asksBeforeNavigating(name)) {
        this.#tellListening(this.#listening());
      }
    };
    /**
     * Hears the app add and remove the listeners its navigations wait on,
     * again after its removeAllListeners took these too.
     */
    readonly #watchNavigationListeners = () => {
      if (
        !this.listeners("newListener").includes(this.#navigationListenerAdded)
      ) {
        this.on("newListener", this.#navigationListenerAdded);
      }
      if (
        !this.listeners("removeListener").includes(
          this.#navigationListenerRemoved,
        )
      ) {
        this.on("removeListener", this.#navigationListenerRemoved);
      }
    };

    /** What the engine was last told of the page's will-navigate listeners. */
    #toldListening = false;
    readonly #listening = () =>
      ASKS_BEFORE_NAVIGATING.some((name) => this.listenerCount(name) > 0);
    readonly #tellListening = (listening: boolean) => {
      if (this.owner.isOpen() && listening !== this.#toldListening) {
        this.#toldListening = listening;
        toEngine({
          listening,
          type: "navigation_listen",
          window: this.owner.id,
        });
      }
    };
    /** Tells a newly opened page's engine window, which starts out not listening. */
    readonly opened = () => {
      this.#toldListening = false;
      this.#tellListening(this.#listening());
    };

    get caretBrowsingEnabled() {
      return this.isCaretBrowsingEnabled();
    }
    set caretBrowsingEnabled(enabled: boolean) {
      this.setCaretBrowsingEnabled(enabled);
    }

    /**
     * The frame with the keyboard. The host reaches only the main frame, so
     * it is that while the page has the keyboard.
     */
    get focusedFrame() {
      return this.isFocused() ? this.mainFrame : null;
    }

    /**
     * `webContents.send` to frame `frameId`, alone or with its renderer's id.
     * The preload, and so `ipcRenderer`, runs only in the main frame, as in
     * Electron without `nodeIntegrationInSubFrames`: another frame has
     * nothing to hear it.
     */
    readonly sendToFrame = (
      frameId: number | readonly [number, number],
      channel: string,
      ...args: unknown[]
    ) => {
      const [processId, routingId] =
        typeof frameId === "number" ? [this.getProcessId(), frameId] : frameId;
      // Before the engine tells of the page's frame, it has none to send to.
      if (
        this.#state !== undefined &&
        processId === this.#state.process_id &&
        routingId === this.#state.routing_id
      ) {
        this.send(channel, ...args);
      } else {
        warnOnce(
          "sendToFrame",
          `${app.getName()} sent to a frame other than a page's main frame, which has no preload to hear it`,
        );
      }
    };

    /** Its page's main frame, the one frame the app reaches. */
    get mainFrame() {
      this.#mainFrame ??= new WebFrameMain(this.owner);
      return this.#mainFrame;
    }

    #frames: ReturnType<typeof createFrames<WebFrameMain>> | undefined;
    /** The page's frames the engine has named. */
    get frames() {
      this.#frames ??= createFrames(this.mainFrame);
      return this.#frames;
    }

    /**
     * Runs `code` in the page's own world once its page has loaded, and
     * resolves with what it gives, a promise settled, as JSON carries it.
     */
    readonly executeJavaScript = (code: string, userGesture = false) =>
      this.owner.runJavaScript(code, userGesture);

    get id() {
      return this.owner.id;
    }

    get session() {
      return this.owner.session;
    }

    #windowOpenHandler:
      | ((details: WindowOpenDetails) => WindowOpenAnswer)
      | undefined;

    /** Decides on each window the page asks for, before any opens. */
    readonly setWindowOpenHandler = (
      handler: ((details: WindowOpenDetails) => WindowOpenAnswer) | null,
    ) => {
      this.#windowOpenHandler = handler ?? undefined;
    };

    /** The handler's answer for `details`: allowed when there's none, as in Electron. */
    readonly windowOpenAnswer = (
      details: WindowOpenDetails,
    ): WindowOpenAnswer => {
      if (this.#windowOpenHandler === undefined) {
        return { action: "allow" };
      }
      const answer: unknown = this.#windowOpenHandler(details);
      if (
        typeof answer === "object" &&
        answer !== null &&
        "action" in answer &&
        (answer.action === "allow" || answer.action === "deny")
      ) {
        return answer as WindowOpenAnswer;
      }
      throw new Error(
        `a window open handler answers { action: "allow" } or { action: "deny" }, not ${JSON.stringify(answer)}`,
      );
    };

    readonly getTitle = () => this.owner.getTitle();
    /** A window's page, or a view's. */
    readonly getType = () =>
      this.owner instanceof BrowserWindow ? "window" : "browserView";
    readonly focus = () => {
      if (this.owner instanceof BrowserWindow) {
        this.owner.focus();
      }
    };
    /** What the engine last said of the page; nothing before it has. */
    #state: PageState | undefined;

    /** The page's history, as the engine last said, oldest first. */
    readonly #entries = () =>
      this.#state?.entries ?? [{ title: this.getTitle(), url: this.owner.url }];
    readonly #index = () => this.#state?.index ?? 0;

    /**
     * The engine keeps each page's history; the app walks it by index, as
     * the engine last listed it. An index it doesn't have does nothing, as
     * in Electron.
     */
    readonly navigationHistory = {
      canGoBack: () => this.navigationHistory.canGoToOffset(-1),
      canGoForward: () => this.navigationHistory.canGoToOffset(1),
      canGoToOffset: (offset: number) => {
        const index = this.#index() + offset;
        return index >= 0 && index < this.#entries().length;
      },
      clear: () => {
        if (this.owner.isOpen()) {
          toEngine({ type: "clear_history", window: this.owner.id });
        }
      },
      getActiveIndex: () => this.#index(),
      getAllEntries: () => this.#entries().map((entry) => ({ ...entry })),
      getEntryAtIndex: (index: number) => {
        const entry = this.#entries()[index];
        return entry === undefined ? null : { ...entry };
      },
      goBack: () => this.navigationHistory.goToOffset(-1),
      goForward: () => this.navigationHistory.goToOffset(1),
      goToIndex: (index: number) => {
        if (
          this.owner.isOpen() &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < this.#entries().length &&
          index !== this.#index()
        ) {
          toEngine({ index, type: "go_to_index", window: this.owner.id });
        }
      },
      goToOffset: (offset: number) =>
        this.navigationHistory.goToIndex(this.#index() + offset),
      length: () => this.#entries().length,
      /** Whether entry `index` goes: one the page has and doesn't show. */
      removeEntryAtIndex: (index: number) => {
        const removable =
          this.owner.isOpen() &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < this.#entries().length &&
          index !== this.#index();
        if (removable) {
          toEngine({
            index,
            type: "remove_history_entry",
            window: this.owner.id,
          });
        }
        return removable;
      },
      /**
       * Opens the page with `entries`, at `index` or the newest, as
       * Electron restores only into a page that hasn't navigated. Resolves
       * once that entry loads.
       */
      restore: ({
        entries,
        index = entries.length - 1,
      }: {
        entries: readonly { url: string; title: string }[];
        index?: number;
      }) => {
        const shown = entries[index];
        if (!Number.isInteger(index) || index < 0 || shown === undefined) {
          throw new Error(
            "Invalid index. Index must be a positive integer and within the bounds of the entries length.",
          );
        } else if (this.owner.isOpen()) {
          throw new Error(
            "navigationHistory.restore can only be used on a WebContents that has no existing history entries",
          );
        } else {
          const restored = this.owner.openWithHistory({
            entries: entries.map(({ title, url }) => ({ title, url })),
            index,
          });
          // Electron's has a rejection handler of its own, so an app that
          // doesn't wait on it hears of no failure it didn't ask about.
          restored.catch(() => {
            /* no-op */
          });
          return restored;
        }
      },
    };

    /**
     * Takes what the engine says the page is now, with Electron's events
     * for what changed.
     */
    readonly takeState = (state: PageState) => {
      const was = this.#state;
      this.#state = state;
      if (state.loading && was?.loading !== true) {
        this.emit("did-start-loading");
      } else if (!state.loading && was?.loading === true) {
        this.emit("did-stop-loading");
      }
      if (state.focused !== (was?.focused ?? false)) {
        this.emit(state.focused ? "focus" : "blur");
        this.owner.focusChanged(state.focused);
      }
      if (state.crashed && was?.crashed !== true) {
        this.emit("render-process-gone", eventObject(), {
          exitCode: 0,
          reason: "crashed",
        });
      }
    };
    /** Sends `request` for the page, if its window is still open. */
    readonly #toPage = (request: PageRequest) => {
      if (this.owner.isOpen()) {
        toEngine({ ...request, window: this.owner.id });
      }
    };
    readonly #edit = (command: EditCommand) => () =>
      this.#toPage({ command, type: "edit" });
    // The Edit menu, at the page's focus.
    readonly undo = this.#edit("undo");
    readonly redo = this.#edit("redo");
    readonly cut = this.#edit("cut");
    readonly copy = this.#edit("copy");
    readonly paste = this.#edit("paste");
    readonly pasteAndMatchStyle = this.#edit("paste_and_match_style");
    readonly delete = this.#edit("delete");
    readonly selectAll = this.#edit("select_all");
    readonly unselect = this.#edit("unselect");
    readonly centerSelection = this.#edit("center_selection");
    readonly replace = (text: string) =>
      this.#toPage({ misspelling: false, text, type: "replace" });
    readonly replaceMisspelling = (text: string) =>
      this.#toPage({ misspelling: true, text, type: "replace" });

    /** The number the last findInPage was given. */
    #lastFind = 0;
    /**
     * Searches the page, answering with `found-in-page` once the search is
     * done, as Electron does. Gives the search's number.
     */
    readonly findInPage = (
      text: string,
      { findNext = false, forward = true, matchCase = false }: FindOptions = {},
    ) => {
      if (text === "") {
        throw new Error("Must provide a non-empty search content");
      }
      this.#lastFind += 1;
      this.#toPage({
        find_next: findNext,
        forward,
        match_case: matchCase,
        request: this.#lastFind,
        text,
        type: "find_in_page",
      });
      return this.#lastFind;
    };
    readonly stopFindInPage = (action: StopFindAction) => {
      if (!Object.hasOwn(STOP_FIND_ACTIONS, action)) {
        throw new Error("Invalid action for stopFindInPage");
      }
      this.#toPage({
        action: STOP_FIND_ACTIONS[action],
        type: "stop_find_in_page",
      });
    };
    /** Takes a search's last answer from the engine. */
    readonly found = ({
      active_match_ordinal,
      matches,
      request,
      selection,
    }: FoundInPage) => {
      this.emit("found-in-page", eventObject(), {
        activeMatchOrdinal: active_match_ordinal,
        finalUpdate: true,
        matches,
        requestId: request,
        selectionArea: { ...selection },
      });
    };

    /** Takes a context menu the user asked for over the page. */
    readonly contextMenu = (menu: ContextMenuAsked) => {
      this.emit(
        "context-menu",
        eventObject(),
        contextMenuParams(menu, this.mainFrame),
      );
    };

    // Electron's older names for the same, which apps such as Element call.
    readonly canGoBack = this.navigationHistory.canGoBack;
    readonly canGoForward = this.navigationHistory.canGoForward;
    readonly canGoToOffset = this.navigationHistory.canGoToOffset;
    readonly clearHistory = this.navigationHistory.clear;
    readonly goBack = this.navigationHistory.goBack;
    readonly goForward = this.navigationHistory.goForward;
    readonly goToIndex = this.navigationHistory.goToIndex;
    readonly goToOffset = this.navigationHistory.goToOffset;
    zoomFactor = 1;
    zoomLevel = 0;
    zoomMode: ZoomMode = "default";
    readonly isFocused = () => this.#state?.focused ?? false;
    readonly isLoading = () => this.#state?.loading ?? false;
    /** The engine says only whether the page loads, frames and all. */
    readonly isLoadingMainFrame = () => this.isLoading();
    readonly isWaitingForResponse = () => this.#state?.waiting ?? false;
    readonly isCrashed = () => this.#state?.crashed ?? false;
    readonly reload = () => this.owner.loadURL(this.owner.url);
    // A workspace is DevTools', which the desktop doesn't give apps.
    readonly addWorkSpace = (_path: string) => undefined;
    readonly removeWorkSpace = (_path: string) => undefined;
    readonly getOSProcessId = () => this.#state?.pid ?? 0;
    /** Chromium's number for the page's renderer, as Electron's. */
    readonly getProcessId = () => this.#state?.process_id ?? 0;
    /** What the engine last said of the page; nothing before it has. */
    readonly pageState = () => this.#state;
    // The engine's DevTools aren't the app's to open yet.
    readonly openDevTools = (_options?: unknown) => undefined;
    readonly closeDevTools = () => undefined;
    readonly isDevToolsOpened = () => false;
    readonly isDevToolsFocused = () => false;
    readonly toggleDevTools = () => undefined;
    // The engine's settings for every page, not each app's.
    readonly setBackgroundThrottling = (_allowed: boolean) => undefined;
    readonly getBackgroundThrottling = () => true;
    readonly setUserAgent = (userAgent: string) =>
      this.pageEvents.setUserAgent(userAgent);
    readonly getUserAgent = () => this.pageEvents.getUserAgent();
    readonly setAudioMuted = (muted: boolean) =>
      this.pageEvents.setAudioMuted(muted);
    readonly isAudioMuted = () => this.pageEvents.isAudioMuted();
    get audioMuted() {
      return this.isAudioMuted();
    }
    set audioMuted(muted: boolean) {
      this.setAudioMuted(muted);
    }
    get backgroundThrottling() {
      return this.getBackgroundThrottling();
    }
    set backgroundThrottling(allowed: boolean) {
      this.setBackgroundThrottling(allowed);
    }
    get userAgent() {
      return this.getUserAgent();
    }
    set userAgent(userAgent: string) {
      this.setUserAgent(userAgent);
    }
    readonly isCurrentlyAudible = () => this.pageEvents.isCurrentlyAudible();
    // The shell zooms pages: the app's zoom is kept, not applied.
    readonly getZoomFactor = () => this.zoomFactor;
    readonly getZoomMode = () => this.zoomMode;
    readonly setZoomMode = (mode: ZoomMode) => {
      if (ZOOM_MODES.includes(mode)) {
        this.zoomMode = mode;
      } else {
        throw new TypeError(`Invalid zoom mode: ${mode}`);
      }
    };
    readonly getZoomLevel = () => this.zoomLevel;
    readonly setZoomFactor = (factor: number) => {
      this.zoomFactor = factor;
    };
    readonly setZoomLevel = (level: number) => {
      this.zoomLevel = level;
    };
    readonly setVisualZoomLevelLimits = async (_min: number, _max: number) =>
      undefined;
    readonly setIgnoreMenuShortcuts = (ignore: boolean) =>
      this.pageEvents.setIgnoreMenuShortcuts(ignore);
    /** Sends Electron's input event `event` to the page, as though the user did. */
    readonly sendInputEvent = (event: unknown) =>
      this.pageEvents.sendInputEvent(event);
    readonly getURL = () => this.owner.url;
    readonly isDestroyed = () => this.owner.isDestroyed();
    readonly loadFile = (path: string) => this.owner.loadFile(path);
    readonly loadURL = (url: string) => this.owner.loadURL(url);
    /** Closes the page at once: a window's ends the window. */
    readonly close = () => {
      this.owner.destroy();
    };

    /**
     * Sends `args` on `channel` to the page's `ipcRenderer`. They travel as
     * JSON, so what JSON can't carry doesn't arrive.
     */
    readonly send = (channel: string, ...args: unknown[]) => {
      this.owner.assertAlive();
      // Before its page opens there's no page to hear it, as in Electron.
      if (!this.owner.isOpen()) {
        return;
      }
      toEngine({
        args: JSON.parse(JSON.stringify(args)),
        channel,
        type: "ipc_send",
        window: this.owner.id,
      });
    };

    /**
     * Posts `message` to the page's `ipcRenderer`, with `transfer`, ends of
     * MessageChannelMains, as `event.ports`. The message travels as JSON.
     */
    readonly postMessage = (
      channel: string,
      message: unknown,
      transfer: readonly MessagePortMain[] = [],
    ) => {
      this.owner.assertAlive();
      if (!this.owner.isOpen()) {
        return;
      }
      toEngine({
        channel,
        message: JSON.parse(JSON.stringify([message]))[0],
        ports: ports.give(this.owner.id, transfer),
        type: "ipc_post",
        window: this.owner.id,
      });
    };
  }

  /**
   * One page on the engine, a window's or a view's: what both kinds share.
   * The engine has no empty pages, so it opens with the first load.
   */
  abstract class Page extends EventEmitter {
    readonly id = nextId++;
    /** Its page's DevTools events, which page calls drive. */
    readonly devtools: DevToolsEvents = new EventEmitter();
    /** Whether its page shows on the desk. */
    abstract readonly isShowing: () => boolean;
    readonly webContents = new WebContents(this);
    url = "";
    /** Its page's session. */
    readonly session: Session;
    protected title: string;
    protected opened = false;
    /** Whether the engine has its page: whether a load has started. */
    readonly isOpen = () => this.opened;
    protected destroyed = false;
    #loads: { resolve: () => void; reject: (why: Error) => void }[] = [];
    /** Whether a load has started that hasn't finished. */
    #loading = false;
    /** The app's scripts that wait for the page to load. */
    #toRun: (() => void)[] = [];
    /** The settings the app made before the page opened, to send as it does. */
    #settings: PageMethod[] = [];
    /** The app's scripts and page calls the engine runs, by call. */
    #running = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (why: Error) => void }
    >();
    readonly #preload: string | undefined;
    readonly #arguments: readonly string[];
    /** Node.js in its page, for a window that isn't sandboxed. */
    readonly #node: PageNode | undefined;
    readonly #view: boolean;
    /** Its webPreferences, which the windows its page opens start from. */
    readonly preferences: WebPreferences;

    constructor(preferences: WebPreferences, title: string, view: boolean) {
      super();
      this.preferences = preferences;
      // As Electron decides: nodeIntegration turns the default sandbox off.
      const sandboxed =
        preferences.sandbox ?? preferences.nodeIntegration !== true;
      const isolated = preferences.contextIsolation !== false;
      if (sandboxed && !isolated) {
        refuse(
          "this window's sandboxed preload runs in its page's own world, which Domicile's engine doesn't give a preload",
        );
      }
      const session =
        preferences.session ??
        sessions.fromPartition(preferences.partition ?? "");
      const sessionPreloads = framePreloadsOf(session);
      if (!sandboxed && sessionPreloads.length > 0) {
        refuse(
          "this window's session has preloads, which Domicile's engine runs only in a sandboxed page",
        );
      }
      this.#preload = sandboxed
        ? preloadSource(readPreload, sessionPreloads, preferences.preload)
        : undefined;
      this.#arguments = preferences.additionalArguments ?? [];
      // Node in the page loads the preload from its file.
      this.#node = sandboxed
        ? undefined
        : {
            ...nodeBase(),
            app_path: app.getAppPath(),
            context_isolation: isolated,
            integration: preferences.nodeIntegration === true,
            ...(preferences.preload === undefined
              ? {}
              : { preload: resolve(preferences.preload) }),
          };
      this.session = session;
      this.title = title;
      this.#view = view;
      if (preferences.enablePreferredSizeMode === true) {
        this.webContents.pageEvents.enablePreferredSizeMode();
      }
      pages.set(this.id, this);
      this.#stopEmulating = followNetworkEmulation(session, this);
    }

    /** Stops following its session's network emulation. */
    readonly #stopEmulating: () => void;

    /** Electron's web-contents-created, which each subclass's constructor ends with. */
    protected created() {
      app.emit(
        "web-contents-created",
        { ...eventObject(), sender: this.webContents },
        this.webContents,
      );
    }

    /**
     * Runs `code` in the page's main world, after any load under way, as
     * Electron's executeJavaScript waits for one.
     */
    readonly runJavaScript = async (code: string, userGesture: boolean) => {
      await this.#loaded();
      const call = nextCall++;
      return new Promise<unknown>((resolve, reject) => {
        this.#running.set(call, { reject, resolve });
        toEngine({
          call,
          code,
          type: "execute_javascript",
          window: this.id,
          ...(userGesture ? { user_gesture: true } : {}),
        });
      });
    };

    /** Waits out any load under way, as Electron's executeJavaScript does. */
    readonly #loaded = async () => {
      this.assertAlive();
      if (!this.opened || this.#loading) {
        await new Promise<void>((resolve) => this.#toRun.push(resolve));
      }
      this.assertAlive();
    };

    /** Has the engine carry `method` out on the page. */
    readonly call = (method: PageMethod): Promise<unknown> => {
      this.assertAlive();
      if (this.opened) {
        const call = nextCall++;
        return new Promise<unknown>((resolve, reject) => {
          this.#running.set(call, { reject, resolve });
          toEngine({ ...method, call, type: "page_call", window: this.id });
        });
      } else {
        return Promise.reject(
          new Error(
            "the page has opened nothing yet: the app loads a URL into it first",
          ),
        );
      }
    };

    /** As `call`, after any load under way. */
    readonly callAfterLoad = async (method: PageMethod) => {
      await this.#loaded();
      return this.call(method);
    };

    /** Sends a setting now, or as the page opens. */
    readonly set = (method: PageMethod) => {
      this.assertAlive();
      if (this.opened) {
        this.call(method).catch((error: unknown) => {
          say(
            Priority.Error,
            `electron-host: window ${this.id} didn't take ${method.method}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else {
        this.#settings.push(method);
      }
    };

    /** The page opened: the settings made before reach it. */
    readonly #sendSettings = () => {
      for (const method of this.#settings.splice(0)) {
        this.set(method);
      }
    };

    /** Shows `url`. Resolves once the page loads, as Electron's does. */
    readonly loadURL = (url: string) => {
      const loaded = this.#load(url);
      if (this.opened) {
        toEngine({ type: "load_url", url, window: this.id });
      } else {
        this.#open({ type: "open_window", url, ...this.#openKeys() });
      }
      return loaded;
    };

    /**
     * Opens the page with `history` instead of a load of its own, showing
     * its entry `index`. Resolves once that entry loads.
     */
    readonly openWithHistory = (history: RestoredHistory) => {
      const url = history.entries[history.index]?.url;
      if (url === undefined || this.opened) {
        throw new Error(
          "a page opens with a history once, at an entry the history has",
        );
      } else {
        const loaded = this.#load(url);
        this.#open({ history, type: "open_window", url, ...this.#openKeys() });
        return loaded;
      }
    };

    /** A load of `url` the page starts, which settles as it loads or fails. */
    readonly #load = (url: string) => {
      this.assertAlive();
      this.url = url;
      this.#loading = true;
      return new Promise<void>((resolve, reject) => {
        this.#loads.push({ reject, resolve });
      });
    };

    readonly #open = (request: EngineRequest) => {
      this.opened = true;
      toEngine(request);
      this.#sendSettings();
      this.webContents.opened();
      this.webContents.pageEvents.opened();
      this.wasOpened();
    };

    /** What the engine is told of the page as it opens. */
    readonly #openKeys = (): OpenKeys => {
      const session = sessionPartition(this.session);
      return {
        window: this.id,
        ...(this.#preload === undefined ? {} : { preload: this.#preload }),
        ...(this.#arguments.length === 0 ? {} : { arguments: this.#arguments }),
        ...(this.#node === undefined ? {} : { node: this.#node }),
        ...(session === "" ? {} : { session }),
        ...(this.#view ? { view: true } : {}),
        ...this.webContents.pageEvents.openKeys(),
        ...this.opening(),
      };
    };

    /**
     * Opens the page as the window another page asked for at `url`, which
     * window open ask `ask` allowed, instead of with a load of its own.
     */
    readonly openAsAsked = (ask: number, url: string) => {
      this.assertAlive();
      if (this.opened) {
        throw new Error(
          "a page's new window opens as a new BrowserWindow; this one already loaded a page",
        );
      }
      this.url = url;
      this.#loading = true;
      this.opened = true;
      toEngine({
        action: "allow",
        ask,
        type: "window_open_answer",
        ...this.#openKeys(),
      });
      this.#sendSettings();
      this.webContents.opened();
      this.webContents.pageEvents.opened();
      this.wasOpened();
    };

    /** Asks the app's handler about the window the page asked for. */
    readonly #windowOpen = (
      event: Extract<WindowEvent, { type: "window_open" }>,
    ) => {
      const details: WindowOpenDetails = {
        disposition: event.disposition,
        features: event.features,
        frameName: event.frame_name,
        postBody: undefined,
        referrer: {
          policy: "strict-origin-when-cross-origin",
          url: event.referrer,
        },
        url: event.url,
      };
      let answer: WindowOpenAnswer;
      try {
        answer = this.webContents.windowOpenAnswer(details);
      } catch (error) {
        // A handler that throws opens nothing, and the app hears why.
        toEngine({
          action: "deny",
          ask: event.ask,
          type: "window_open_answer",
        });
        throw error;
      }
      if (answer.action === "deny") {
        toEngine({
          action: "deny",
          ask: event.ask,
          type: "window_open_answer",
        });
        return;
      }
      const options = childWindowOptions(
        this.preferences,
        event.features,
        answer.overrideBrowserWindowOptions,
      );
      if (answer.createWindow === undefined) {
        const child = new BrowserWindow(options);
        child.openAsAsked(event.ask, event.url);
        this.webContents.emit("did-create-window", child, {
          disposition: event.disposition,
          frameName: event.frame_name,
          options,
          postBody: undefined,
          referrer: details.referrer,
          url: event.url,
        });
        return;
      }
      const made = answer.createWindow(options);
      if (!(made instanceof WebContents)) {
        toEngine({
          action: "deny",
          ask: event.ask,
          type: "window_open_answer",
        });
        throw new Error(
          "a window open handler's createWindow returns the new window's webContents",
        );
      }
      made.owner.openAsAsked(event.ask, event.url);
    };

    /** Shows a file of the app, by its path from the app's root. */
    readonly loadFile = (path: string) =>
      this.loadURL(
        pathToFileURL(isAbsolute(path) ? path : join(app.getAppPath(), path))
          .href,
      );

    /** Closes the page without asking it or any listener. */
    readonly destroy = () => {
      if (!this.destroyed) {
        this.end(() => {
          toEngine({ type: "destroy_window", window: this.id });
        });
      }
    };

    readonly isDestroyed = () => this.destroyed;
    readonly getTitle = () => this.title;

    /** Takes what the engine said of this page. */
    readonly take = (event: WindowEvent) => {
      if (isPageEvent(event)) {
        this.webContents.pageEvents.take(event);
        return;
      }
      switch (event.type) {
        case "window_open": {
          this.#windowOpen(event);
          break;
        }
        case "window_opened": {
          // Its first page is loading; `window_loaded` says when it's done.
          break;
        }
        case "window_dom_ready": {
          this.webContents.emit("dom-ready", eventObject());
          break;
        }
        case "window_loaded": {
          this.#loading = false;
          for (const run of this.#toRun.splice(0)) {
            run();
          }
          this.webContents.emit(
            "did-frame-finish-load",
            eventObject(),
            true,
            this.webContents.mainFrame.processId,
            this.webContents.mainFrame.routingId,
          );
          this.webContents.emit("did-finish-load");
          this.wasLoaded();
          for (const load of this.#loads.splice(0)) {
            load.resolve();
          }
          break;
        }
        case "title_changed": {
          this.titled(event.title);
          break;
        }
        case "window_refused": {
          this.#refused(event.why);
          break;
        }
        case "window_closed": {
          this.#closed();
          break;
        }
        case "resized": {
          this.resized(event.width, event.height);
          break;
        }
        case "ipc_message": {
          ipc.receive(this.webContents, event.channel, event.args);
          break;
        }
        case "ipc_invoke": {
          this.#answer(
            event.invoke,
            ipc.invoke(this.webContents, event.channel, event.args),
          );
          break;
        }
        case "ipc_send_sync": {
          this.#answer(
            event.invoke,
            ipc.sendSync(this.webContents, event.channel, event.args),
          );
          break;
        }
        case "ipc_post": {
          ipc.post(
            this.webContents,
            event.channel,
            event.message,
            ports.take(this.id, event.ports),
          );
          break;
        }
        case "port_message": {
          ports.message(this.id, event.port, event.data);
          break;
        }
        case "port_closed": {
          ports.closed(this.id, event.port);
          break;
        }
        case "page_gone": {
          ports.gone(this.id);
          break;
        }
        case "menu_clicked": {
          this.menuClicked(event.command);
          break;
        }
        case "popup_menu_closed": {
          this.popupMenuClosed(event.popup, event.command);
          break;
        }
        case "window_state": {
          const { type: _type, window: _window, ...state } = event;
          this.stateChanged(state);
          break;
        }
        case "close_asked": {
          this.closeAsked();
          break;
        }
        case "page_state": {
          const { type: _type, window: _window, ...state } = event;
          this.webContents.takeState(state);
          break;
        }
        case "found_in_page": {
          this.webContents.found(event);
          break;
        }
        case "context_menu": {
          this.webContents.contextMenu(event);
          break;
        }
        case "navigation_started":
        case "navigation_redirected":
        case "navigation_committed":
        case "will_navigate":
        case "load_failed":
        case "frame_loaded":
        case "frame_created":
        case "will_prevent_unload": {
          takeNavigation(
            {
              committed: (frame, main, url, sameDocument) => {
                if (main) {
                  this.url = url;
                  if (!sameDocument) {
                    this.webContents.frames.clear();
                  }
                } else if (frame instanceof SubFrame) {
                  frame.url = url;
                }
              },
              emit: (name, ...args) => this.webContents.emit(name, ...args),
              failed: (error) => {
                for (const load of this.#loads.splice(0)) {
                  load.reject(error);
                }
              },
              frame: this.webContents.frames.frame,
              toEngine,
            },
            event,
          );
          break;
        }
        case "devtools_event": {
          this.devtools.emit(event.method, event.params);
          break;
        }
        case "page_result":
        case "javascript_result": {
          const running = this.#running.get(event.call);
          this.#running.delete(event.call);
          if (running === undefined) {
            throw new Error(
              `the engine answered call ${event.call} of window ${this.id}, which nothing waits on`,
            );
          } else if (event.error === undefined) {
            running.resolve(event.result);
          } else {
            running.reject(new Error(event.error));
          }
          break;
        }
      }
    };

    /** Throws as Electron does for a page that's gone. */
    readonly assertAlive = () => {
      if (this.destroyed) {
        throw new Error("Object has been destroyed");
      }
    };

    /** What only a window says of itself as it opens. */
    protected opening(): { title?: string; hidden?: true } {
      return {};
    }

    /** Its page took or lost the keyboard focus. */
    focusChanged(_focused: boolean) {
      // Only a window has focus events of its own.
    }

    /** The user asked to close the page's window. */
    protected closeAsked() {
      // Only a window can be closed by the user.
    }

    /** The engine opened the page. */
    protected wasOpened() {
      // Only a window or a view has more to do.
    }

    /** The page loaded. */
    protected wasLoaded() {
      // Only a window has more to do.
    }

    /** The page's title changed to `title`. */
    protected titled(title: string) {
      this.title = title;
      this.webContents.emit("page-title-updated", eventObject(), title, false);
    }

    /** The shell gave the page a size. */
    protected resized(_width: number, _height: number) {
      // Only a window has more to do.
    }

    /** The user chose entry `command` of the page's menu bar. */
    protected menuClicked(_command: number) {
      // Only a window has a menu bar.
    }

    /** The shell made the page's window `state`. */
    protected stateChanged(_state: WindowState) {
      throw new Error(
        `the engine said the state of ${this.id}, which only a window has`,
      );
    }

    /** Popup menu `popup` closed, with entry `command` chosen or 0. */
    protected popupMenuClosed(popup: number, _command: number) {
      throw new Error(
        `the engine closed popup menu ${popup} of ${this.id}, which only a window has`,
      );
    }

    /** The page is gone. */
    protected wasClosed() {
      // Only a window or a view has more to do.
    }

    /** Ends a page that was never opened at once; asks the engine otherwise. */
    protected readonly end = (ask: () => void) => {
      if (this.opened) {
        ask();
      } else {
        this.#closed();
      }
    };

    /** Answers invoke or sendSync `invoke` with `answer`, once it settles. */
    readonly #answer = (
      invoke: number,
      answer: ReturnType<IpcRoutes["invoke"]>,
    ) => {
      answer
        .then((settled) => {
          toEngine(
            settled.match<EngineRequest>({
              Err: (error) => ({ error, invoke, type: "ipc_reply" }),
              Ok: ({ result }) => ({ invoke, result, type: "ipc_reply" }),
            }),
          );
        })
        .catch((error: unknown) => {
          // Only the engine's connection failing gets here, and losing it
          // ends the app on its own.
          say(
            Priority.Error,
            `electron-host: couldn't answer an invoke: ${error instanceof Error ? error.stack : String(error)}`,
          );
        });
    };

    readonly #refused = (why: string) => {
      const loads = this.#loads.splice(0);
      const sent = (sentTo.get(this.id) ?? []).join(", ");
      // An app may swallow its load's rejection; the log keeps why.
      say(
        Priority.Error,
        `electron-host: the engine refused window ${this.id} (last sent: ${sent}): ${why}`,
      );
      if (loads.length > 0) {
        for (const load of loads) {
          load.reject(new Error(why));
        }
      } else if (!this.destroyed) {
        throw new Error(`the engine refused window ${this.id}: ${why}`);
      }
    };

    readonly #closed = () => {
      if (!this.destroyed) {
        this.destroyed = true;
        pages.delete(this.id);
        this.#stopEmulating();
        ports.gone(this.id);
        for (const load of this.#loads.splice(0)) {
          load.reject(new Error("the window closed before its page loaded"));
        }
        // A script waiting to run hears the page is gone, as one running does.
        for (const run of this.#toRun.splice(0)) {
          run();
        }
        for (const running of this.#running.values()) {
          running.reject(
            new Error("the window closed before the engine answered"),
          );
        }
        this.#running.clear();
        this.wasClosed();
        this.webContents.emit("destroyed");
      }
    };
  }

  /**
   * Electron's `WebContentsView`: a page the shell draws as part of the window
   * whose `contentView` holds it, where the app puts it. It outlives that
   * window until the app closes its page.
   */
  class WebContentsView extends Page {
    #bounds: Rectangle = NO_BOUNDS;
    #visible = true;
    /** The window whose contentView holds it. */
    holder: BrowserWindow | undefined;

    constructor(options: ViewOptions = {}) {
      super(options.webPreferences ?? {}, "", true);
      this.created();
    }

    /** Where the app asks for it in its window, in CSS pixels. */
    readonly setBounds = (bounds: Rectangle) => {
      const next = {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y,
      };
      const from = this.#bounds;
      this.#bounds = next;
      this.holder?.placeViews();
      if (
        next.x !== from.x ||
        next.y !== from.y ||
        next.width !== from.width ||
        next.height !== from.height
      ) {
        this.emit("bounds-changed");
      }
    };

    readonly getBounds = (): Rectangle => this.#bounds;

    /** Hides or shows it. A hidden view keeps its page and its place. */
    readonly setVisible = (visible: boolean) => {
      this.#visible = visible;
      this.holder?.placeViews();
    };

    readonly getVisible = () => this.#visible;
    /** Whether a window that shows holds it, and it isn't hidden there. */
    readonly isShowing = () =>
      this.#visible && this.holder?.isShowing() === true;

    /** The shell draws views; the app's color and corners are its own look. */
    readonly setBackgroundColor = (_color: string) => undefined;
    readonly setBorderRadius = (_radius: number) => undefined;
    readonly setBackgroundBlur = (_blur: number) => undefined;

    readonly children: readonly WebContentsView[] = [];

    /** Electron nests views; Domicile's engine has only a window hold them. */
    readonly addChildView = (_view: WebContentsView, _index?: number) => {
      throw new Error(
        "only a window's contentView holds views on Domicile: this app nests a view in a view",
      );
    };

    readonly removeChildView = (_view: WebContentsView) => undefined;

    /** Where the engine is told to put it, or nothing before it opens. */
    readonly placement = (): ViewPlacement | undefined =>
      this.opened && !this.destroyed
        ? {
            ...this.#bounds,
            ...(this.#visible ? {} : { hidden: true }),
            window: this.id,
          }
        : undefined;

    protected override wasOpened() {
      this.holder?.placeViews();
    }

    protected override wasClosed() {
      this.holder?.contentView.removeChildView(this);
    }

    /** Its window has the keyboard while the view's page does. */
    override focusChanged(_focused: boolean) {
      this.holder?.focusMoved();
    }
  }

  /**
   * Electron's `BrowserView`, the older view: a `WebContentsView` placed with
   * the window's `setBrowserView` and kin, which can follow its window's size.
   */
  class BrowserView extends WebContentsView {
    #autoResize: AutoResize = {};

    readonly setAutoResize = (options: AutoResize) => {
      this.#autoResize = options;
    };

    /** Follows its window from `from` to `to`, as its autoResize asks. */
    readonly follow = (
      from: { width: number; height: number },
      to: { width: number; height: number },
    ) => {
      const { height, horizontal, vertical, width } = this.#autoResize;
      const bounds = this.getBounds();
      const scaleX = from.width === 0 ? 1 : to.width / from.width;
      const scaleY = from.height === 0 ? 1 : to.height / from.height;
      const next = {
        height: followed(
          bounds.height,
          vertical,
          height,
          to.height - from.height,
          scaleY,
        ),
        width: followed(
          bounds.width,
          horizontal,
          width,
          to.width - from.width,
          scaleX,
        ),
        x: horizontal ? Math.round(bounds.x * scaleX) : bounds.x,
        y: vertical ? Math.round(bounds.y * scaleY) : bounds.y,
      };
      if (
        next.x !== bounds.x ||
        next.y !== bounds.y ||
        next.width !== bounds.width ||
        next.height !== bounds.height
      ) {
        this.setBounds(next);
      }
    };
  }

  /** A window's `contentView`: its page, and the views over it, bottom first. */
  class ContentView {
    #children: WebContentsView[] = [];

    constructor(private readonly window: BrowserWindow) {}

    get children(): readonly WebContentsView[] {
      return [...this.#children];
    }

    /**
     * Puts `view` at `index`, or on top, taking it from any window that held
     * it. A view it already holds moves.
     */
    readonly addChildView = (view: WebContentsView, index?: number) => {
      const from = view.holder;
      if (from !== undefined && from !== this.window) {
        from.contentView.removeChildView(view);
      }
      this.#children = this.#children.filter((child) => child !== view);
      this.#children.splice(index ?? this.#children.length, 0, view);
      view.holder = this.window;
      if (from !== this.window) {
        this.window.viewHeld(view, true);
      }
      this.window.placeViews();
      this.window.focusMoved();
    };

    readonly removeChildView = (view: WebContentsView) => {
      if (this.#children.includes(view)) {
        this.#children = this.#children.filter((child) => child !== view);
        view.holder = undefined;
        this.window.viewHeld(view, false);
        this.window.placeViews();
        this.window.focusMoved();
      }
    };

    /** The window's page fills it, at the size the shell gave it. */
    readonly getBounds = () => this.window.getContentBounds();

    /** The shell lays out windows: a window's size is not the app's to set. */
    readonly setBounds = (_bounds: Rectangle) => undefined;
    readonly setBackgroundColor = (_color: string) => undefined;
  }

  class BrowserWindow extends Page {
    static readonly fromId = (id: number) => windows.get(id) ?? null;
    static readonly getAllWindows = () => [...windows.values()];
    /** The window whose page has the keyboard focus, if one of the app's does. */
    static readonly getFocusedWindow = () =>
      [...windows.values()].find((window) => window.isFocused()) ?? null;
    /** The window of `webContents`' page, or of the view it is. */
    static readonly fromWebContents = (webContents: WebContents) => {
      const { owner } = webContents;
      if (owner instanceof BrowserWindow) {
        return owner;
      } else if (owner instanceof WebContentsView) {
        return owner.holder ?? null;
      } else {
        return null;
      }
    };
    static readonly fromBrowserView = (view: BrowserView) =>
      view.holder ?? null;

    readonly contentView = new ContentView(this);
    readonly getContentView = () => this.contentView;
    /**
     * Kept for the app: the desktop names a window to accessibility tools by
     * the title it shows.
     */
    accessibleTitle = "";
    #shown = false;
    /** Hidden by the app: open, its page running, out of the desk's sight. */
    #hidden: boolean;
    #size: { width: number; height: number };
    /** The views the engine last placed, as it was told them. */
    #placed = "[]";
    #menu: Menu | null = menus.applicationMenu();
    /** Each popup menu up over the window, and what hears it close. */
    readonly #popups = new Map<number, (command: number) => void>();
    #lastPopup = 0;
    #menuBarVisible = true;
    #menuBarAutoHide: boolean;
    /** Whether its page or one of its views' has the keyboard. */
    #focused = false;
    /** Whether an entry of its menu bar or a popup menu is running. */
    #choosing = false;
    /** What the app asks the shell to make the window. */
    #wants: WindowState = NORMAL;
    /** What the shell last made it. */
    #state: WindowState = NORMAL;
    /** What the engine holds the app asked, so it hears each only once. */
    #asked: WindowState = NORMAL;
    #fullScreenable: boolean;
    #parent: BrowserWindow | undefined;
    readonly #modal: boolean;
    /** Whether the app has it take input: setEnabled. */
    #enabled = true;
    /** The modals showing over it, which keep its input from it. */
    readonly #modals = new Set<BrowserWindow>();
    /** Whether the engine was told its pages take no input. */
    #ignoring = false;

    constructor(options: BrowserWindowOptions = {}) {
      // Before anything holds the window, so a parent refused leaves nothing.
      const parent = parentWindow(options.parent);
      super(
        options.webPreferences ?? {},
        options.title ?? app.getName(),
        false,
      );
      this.#hidden = options.show === false;
      this.#size = {
        height: options.height ?? DEFAULT_SIZE.height,
        width: options.width ?? DEFAULT_SIZE.width,
      };
      this.#menuBarAutoHide = options.autoHideMenuBar ?? false;
      this.#fullScreenable = options.fullscreenable ?? true;
      if (options.fullscreen === true && this.#fullScreenable) {
        this.#wants = { ...NORMAL, fullscreen: true };
      }
      this.#menu?.on("changed", this.#showMenuBar);
      this.#parent = parent;
      this.#modal = options.modal === true && this.#parent !== undefined;
      windows.set(this.id, this);
      this.#holdParent();
      this.created();
      app.emit("browser-window-created", eventObject(), this);
    }

    readonly getParentWindow = () => this.#parent ?? null;
    readonly getChildWindows = () =>
      [...windows.values()].filter((window) => window.#parent === this);
    readonly setParentWindow = (parent: BrowserWindow | null) => {
      const next = parentWindow(parent);
      if (next !== undefined && descendsFrom(next, this)) {
        throw new TypeError(
          "a window can't be its own parent, or its parent's",
        );
      } else {
        if (this.#parent !== undefined) {
          this.#parent.#release(this);
        }
        this.#parent = next;
        this.#holdParent();
      }
    };
    readonly isModal = () => this.#modal;

    readonly setEnabled = (enabled: boolean) => {
      this.#enabled = enabled;
      this.#tellInput();
    };
    /** False while the app disables it or a modal of its shows over it. */
    readonly isEnabled = () => this.#enabled && this.#modals.size === 0;

    /** A modal showing keeps its parent's input from it; else it lets go. */
    readonly #holdParent = () => {
      if (this.#modal && this.#parent !== undefined) {
        if (this.isShowing()) {
          this.#parent.#modals.add(this);
          this.#parent.#tellInput();
        } else {
          this.#parent.#release(this);
        }
      }
    };
    readonly #release = (modal: BrowserWindow) => {
      if (this.#modals.delete(modal)) {
        this.#tellInput();
      }
    };

    /** Tells its page and its views' whether they take input, if that changed. */
    readonly #tellInput = () => {
      const ignore = !this.isEnabled();
      if (ignore !== this.#ignoring) {
        this.#ignoring = ignore;
        for (const page of [this, ...this.contentView.children]) {
          page.set({ ignore, method: "set_ignore_input" });
        }
      }
    };

    /** A view it now holds, or holds no more, takes input as it does. */
    readonly viewHeld = (view: WebContentsView, held: boolean) => {
      // A view that closed takes nothing more.
      if (this.#ignoring && !view.isDestroyed()) {
        view.set({ ignore: held, method: "set_ignore_input" });
      }
    };

    /** Whether it shows on the desk: not hidden, and not closed. */
    readonly isShowing = () => !this.#hidden && !this.destroyed;

    /** Its page as the shell last drew it. */
    readonly capturePage: WebContents["capturePage"] = (rect, options) =>
      this.webContents.capturePage(rect, options);

    readonly getMediaSourceId = () => "";

    /** Shows the window if the app hid it, and focuses it. */
    readonly show = () => {
      this.assertAlive();
      this.#setHidden(false);
      this.focus();
    };

    /** Shows the window if the app hid it, leaving focus where it is. */
    readonly showInactive = () => {
      this.assertAlive();
      this.#setHidden(false);
    };

    /**
     * Takes the window out of the desk's sight, its page still running, as
     * an app that closes to its tray does.
     */
    readonly hide = () => {
      this.assertAlive();
      this.#setHidden(true);
    };

    readonly #setHidden = (hidden: boolean) => {
      if (this.#hidden !== hidden) {
        this.#hidden = hidden;
        if (this.opened) {
          toEngine({ hidden, type: "set_hidden", window: this.id });
        }
        this.#holdParent();
        this.emit(hidden ? "hide" : "show");
      }
    };

    readonly focus = () => {
      this.assertAlive();
      if (this.opened) {
        toEngine({ type: "focus_window", window: this.id });
      }
    };

    /** Gives the window's own page the keyboard, as focusing the window does. */
    readonly focusOnWebView = () => {
      this.focus();
    };

    /** Closes the window once its page agrees, unless a `close` listener prevents it. */
    readonly close = () => {
      if (!this.destroyed) {
        const event = eventObject();
        this.emit("close", event);
        if (!event.defaultPrevented) {
          this.end(() => {
            toEngine({ type: "close_window", window: this.id });
          });
        }
      }
    };

    readonly isVisible = () => this.#shown && !this.#hidden && !this.destroyed;
    /** The title the desktop shows for the window, over its page's. */
    readonly setTitle = (title: string) => {
      this.title = title;
      if (this.opened && !this.destroyed) {
        toEngine({ title, type: "set_title", window: this.id });
      }
    };

    /** Its page's box, at the size the shell gave it. */
    readonly getContentBounds = (): Rectangle => ({
      ...this.#size,
      x: 0,
      y: 0,
    });
    /** The shell draws the frame, so the window is its page. */
    readonly getBounds = () => this.getContentBounds();
    readonly getSize = () => [this.#size.width, this.#size.height];
    readonly getContentSize = () => this.getSize();

    // The shell decides each window's state: a window asks for one, and reads
    // as what the shell last made it.
    readonly isMinimized = () => this.#state.minimized;
    readonly isMaximized = () => this.#state.maximized;
    readonly isFullScreen = () => this.#state.fullscreen;
    readonly isNormal = () =>
      !(
        this.#state.maximized ||
        this.#state.minimized ||
        this.#state.fullscreen
      );
    readonly minimize = () => {
      this.#ask({ ...this.#wants, minimized: true });
    };
    /** Electron's restores a minimized window as it maximizes it. */
    readonly maximize = () => {
      this.#ask({ ...this.#wants, maximized: true, minimized: false });
    };
    readonly unmaximize = () => {
      this.#ask({ ...this.#wants, maximized: false });
    };
    /** Out of minimized, back to the state it had. */
    readonly restore = () => {
      this.#ask({ ...this.#wants, minimized: false });
    };
    /** Does nothing for a window that isn't fullscreenable, as Electron. */
    readonly setFullScreen = (flag: boolean) => {
      if (this.#fullScreenable || !flag) {
        this.#ask({ ...this.#wants, fullscreen: flag });
      }
    };
    readonly isFullScreenable = () => this.#fullScreenable;
    readonly setFullScreenable = (fullscreenable: boolean) => {
      this.#fullScreenable = fullscreenable;
    };
    // The shell lays windows out: they read as the shell keeps them, where it
    // put them.
    readonly isSimpleFullScreen = () => false;
    readonly isKiosk = () => false;
    readonly isAlwaysOnTop = () => false;
    readonly isFocusable = () => true;
    readonly isResizable = () => true;
    readonly isMovable = () => true;
    readonly isMinimizable = () => true;
    readonly isMaximizable = () => true;
    readonly isClosable = () => true;
    readonly isVisibleOnAllWorkspaces = () => false;
    readonly blur = () => undefined;
    readonly blurWebView = () => undefined;
    readonly center = () => undefined;
    readonly setSimpleFullScreen = (_flag: boolean) => undefined;
    readonly setKiosk = (_flag: boolean) => undefined;
    readonly setAlwaysOnTop = (_flag: boolean, _level?: string) => undefined;
    readonly moveTop = () => undefined;
    readonly moveAbove = (_mediaSourceId: string) => undefined;
    readonly setFocusable = (_focusable: boolean) => undefined;
    readonly setResizable = (_resizable: boolean) => undefined;
    readonly setMovable = (_movable: boolean) => undefined;
    readonly setMinimizable = (_minimizable: boolean) => undefined;
    readonly setMaximizable = (_maximizable: boolean) => undefined;
    readonly setClosable = (_closable: boolean) => undefined;
    readonly setSkipTaskbar = (_skip: boolean) => undefined;
    readonly setVisibleOnAllWorkspaces = (_visible: boolean) => undefined;
    readonly setMinimumSize = (_width: number, _height: number) => undefined;
    readonly setMaximumSize = (_width: number, _height: number) => undefined;
    readonly getMinimumSize = () => [0, 0];
    readonly getMaximumSize = () => [0, 0];
    readonly setAspectRatio = (_ratio: number) => undefined;
    readonly setBounds = (_bounds: Partial<Rectangle>) => undefined;
    readonly setSize = (_width: number, _height: number) => undefined;
    readonly setContentSize = (_width: number, _height: number) => undefined;
    readonly setContentBounds = (_bounds: Partial<Rectangle>) => undefined;
    readonly setPosition = (_x: number, _y: number) => undefined;
    readonly getPosition = () => [0, 0];
    readonly getNormalBounds = () => this.getBounds();
    // The desktop file names the app's icon, and the shell draws windows.
    readonly setIcon = (_icon: unknown) => undefined;
    readonly setBackgroundColor = (_color: string) => undefined;
    readonly getBackgroundColor = () => "#FFFFFF";
    readonly setHasShadow = (_shadow: boolean) => undefined;
    readonly hasShadow = () => false;
    readonly setOpacity = (_opacity: number) => undefined;
    readonly getOpacity = () => 1;
    readonly setIgnoreMouseEvents = (_ignore: boolean) => undefined;
    readonly setProgressBar = (_progress: number) => undefined;
    // The shell draws every window's frame, so there is no title bar to
    // overlay.
    readonly setTitleBarOverlay = (_options: unknown) => undefined;
    readonly setContentProtection = (_enable: boolean) => undefined;
    readonly isContentProtected = () => false;
    /** No shell shows an attention request yet. */
    readonly flashFrame = (_flag: boolean) => undefined;
    readonly getNativeWindowHandle = () => Buffer.alloc(8);
    /**
     * Whether it is the app's window with the keyboard, as Electron's: its
     * page or one of its views' has it, or the user is choosing from its menu
     * bar or a menu it popped up, which the shell draws and which has the
     * keyboard meanwhile.
     */
    readonly isFocused = () => this.#choosing || this.#focused;

    override focusChanged(_focused: boolean) {
      this.focusMoved();
    }

    /**
     * The keyboard moved in or out of its page or one of its views': says
     * focus or blur when the window took or lost it. Focus moving from the
     * page to a view says blur, then focus, as the engine reports each page
     * on its own.
     */
    readonly focusMoved = () => {
      const focused =
        this.webContents.isFocused() ||
        this.contentView.children.some((view) => view.webContents.isFocused());
      if (focused !== this.#focused) {
        this.#focused = focused;
        const event = eventObject();
        this.emit(focused ? "focus" : "blur", event);
        app.emit(
          focused ? "browser-window-focus" : "browser-window-blur",
          event,
          this,
        );
      }
    };
    readonly reload = () => this.webContents.reload();

    readonly setBrowserView = (view: BrowserView | null) => {
      for (const held of this.getBrowserViews()) {
        if (held !== view) {
          this.contentView.removeChildView(held);
        }
      }
      if (view !== null) {
        this.contentView.addChildView(view);
      }
    };

    readonly addBrowserView = (view: BrowserView) => {
      this.contentView.addChildView(view);
    };

    readonly removeBrowserView = (view: BrowserView) => {
      this.contentView.removeChildView(view);
    };

    readonly setTopBrowserView = (view: BrowserView) => {
      this.contentView.addChildView(view);
    };

    readonly getBrowserViews = () =>
      this.contentView.children.filter(
        (child): child is BrowserView => child instanceof BrowserView,
      );

    /** Its one BrowserView, as Electron throws for a window with more. */
    readonly getBrowserView = () => {
      const views = this.getBrowserViews();
      if (views.length > 1) {
        throw new Error(
          "BrowserWindow have multiple BrowserViews, use getBrowserViews() instead: this window holds more than one BrowserView",
        );
      }
      return views[0] ?? null;
    };

    /** Shows `menu` in the window's menu bar, or no menu bar for null. */
    readonly setMenu = (menu: Menu | null) => {
      this.assertAlive();
      this.#menu?.off("changed", this.#showMenuBar);
      this.#menu = menu;
      this.#menu?.on("changed", this.#showMenuBar);
      this.#showMenuBar();
    };

    readonly removeMenu = () => {
      this.setMenu(null);
    };

    readonly setMenuBarVisibility = (visible: boolean) => {
      this.#menuBarVisible = visible;
      this.#showMenuBar();
    };

    readonly isMenuBarVisible = () => this.#menuBarVisible;

    readonly setAutoHideMenuBar = (autoHide: boolean) => {
      this.#menuBarAutoHide = autoHide;
      this.#showMenuBar();
    };

    readonly isMenuBarAutoHide = () => this.#menuBarAutoHide;

    // Electron's properties for what the methods above set and read.
    get autoHideMenuBar() {
      return this.isMenuBarAutoHide();
    }
    set autoHideMenuBar(autoHide: boolean) {
      this.setAutoHideMenuBar(autoHide);
    }
    get menuBarVisible() {
      return this.isMenuBarVisible();
    }
    set menuBarVisible(visible: boolean) {
      this.setMenuBarVisibility(visible);
    }
    get fullScreen() {
      return this.isFullScreen();
    }
    set fullScreen(flag: boolean) {
      this.setFullScreen(flag);
    }
    get simpleFullScreen() {
      return this.isSimpleFullScreen();
    }
    set simpleFullScreen(flag: boolean) {
      this.setSimpleFullScreen(flag);
    }
    get fullScreenable() {
      return this.isFullScreenable();
    }
    set fullScreenable(flag: boolean) {
      this.setFullScreenable(flag);
    }
    get kiosk() {
      return this.isKiosk();
    }
    set kiosk(flag: boolean) {
      this.setKiosk(flag);
    }
    get resizable() {
      return this.isResizable();
    }
    set resizable(flag: boolean) {
      this.setResizable(flag);
    }
    get visibleOnAllWorkspaces() {
      return this.isVisibleOnAllWorkspaces();
    }
    set visibleOnAllWorkspaces(flag: boolean) {
      this.setVisibleOnAllWorkspaces(flag);
    }
    get shadow() {
      return this.hasShadow();
    }
    set shadow(flag: boolean) {
      this.setHasShadow(flag);
    }

    /** Tells the engine the menu bar as it is now, once the window is open. */
    readonly #showMenuBar = () => {
      if (this.opened && !this.destroyed) {
        toEngine({
          auto_hide: this.#menuBarAutoHide,
          menu: this.#menu === null ? null : menus.model(this.#menu),
          type: "set_menu_bar",
          visible: this.#menuBarVisible,
          window: this.id,
        });
      }
    };

    /** Tells the engine where the window's open views go, if that changed. */
    readonly placeViews = () => {
      if (this.opened && !this.destroyed) {
        const views = this.contentView.children.flatMap(
          (view) => view.placement() ?? [],
        );
        const placed = JSON.stringify(views);
        if (placed !== this.#placed) {
          this.#placed = placed;
          toEngine({ type: "set_views", views, window: this.id });
        }
      }
    };

    /** Asks the shell to make the window `wants`, once it is open. */
    readonly #ask = (wants: WindowState) => {
      this.assertAlive();
      this.#wants = wants;
      this.#tellWants();
    };

    readonly #tellWants = () => {
      const wants = this.#wants;
      if (this.opened && !this.destroyed && !sameState(wants, this.#asked)) {
        this.#asked = wants;
        toEngine({
          fullscreen: wants.fullscreen,
          maximized: wants.maximized,
          minimized: wants.minimized,
          type: "set_window_state",
          window: this.id,
        });
      }
    };

    protected override stateChanged(state: WindowState) {
      const was = this.#state;
      this.#state = state;
      // What the user did, such as leaving fullscreen, is what the app's next
      // ask starts from. The engine keeps what was last asked, and the shell
      // acts only when that changes: a change the user made away from it is
      // asked back, or the app asking for the same again would do nothing.
      // The shell's word on a window that hasn't changed, such as the first
      // before it acts on an ask, leaves the ask be.
      this.#wants = state;
      if (!sameState(was, state)) {
        this.#tellWants();
      }
      if (was.maximized !== state.maximized) {
        this.emit(state.maximized ? "maximize" : "unmaximize");
      }
      if (!was.minimized && state.minimized) {
        this.emit("minimize");
      }
      if (was.fullscreen !== state.fullscreen) {
        this.emit(state.fullscreen ? "enter-full-screen" : "leave-full-screen");
      }
      if (was.minimized && !state.minimized) {
        this.emit("restore");
      }
    }

    protected override wasOpened() {
      this.placeViews();
      this.#tellWants();
      // A window opens with no menu bar, so there's only one to tell of.
      if (this.#menu !== null) {
        this.#showMenuBar();
      }
    }

    protected override menuClicked(command: number) {
      if (this.#menu !== null) {
        this.#choosing = true;
        try {
          menus.click(this.#menu, command, this.id);
        } finally {
          this.#choosing = false;
        }
      }
    }

    /**
     * Has the shell draw `menu` over the window (`Menu.popup`), at `at` in
     * CSS pixels from its page's top left, or where the user last pressed.
     * `closed` hears the entry chosen, or 0; the function returned puts it
     * away.
     */
    readonly popupMenu = (
      menu: readonly MenuEntry[],
      at: { x: number; y: number } | undefined,
      closed: (command: number) => void,
    ): (() => void) => {
      this.assertAlive();
      if (!this.opened) {
        // Nothing is drawn yet to draw it over: it closes as it opens.
        queueMicrotask(() => {
          closed(0);
        });
        return () => undefined;
      }
      this.#lastPopup += 1;
      const popup = this.#lastPopup;
      this.#popups.set(popup, closed);
      toEngine({
        menu,
        popup,
        type: "popup_menu",
        window: this.id,
        ...(at === undefined ? {} : { x: at.x, y: at.y }),
      });
      return () => {
        if (this.#popups.has(popup) && !this.destroyed) {
          toEngine({ popup, type: "close_popup_menu", window: this.id });
        }
      };
    };

    protected override popupMenuClosed(popup: number, command: number) {
      const closed = this.#popups.get(popup);
      if (closed === undefined) {
        throw new Error(
          `the engine closed popup menu ${popup} of window ${this.id}, which was not up`,
        );
      }
      this.#popups.delete(popup);
      // The shell's popup had the keyboard, but the window is the focused
      // one while the entry chosen runs, as on Electron.
      this.#choosing = true;
      try {
        closed(command);
      } finally {
        this.#choosing = false;
      }
    }

    protected override wasLoaded() {
      if (!this.#shown) {
        this.#shown = true;
        this.emit("ready-to-show");
      }
    }

    protected override titled(title: string) {
      const titleEvent = eventObject();
      this.emit("page-title-updated", titleEvent, title, false);
      if (!titleEvent.defaultPrevented) {
        this.setTitle(title);
      }
    }

    protected override opening() {
      return {
        title: this.title,
        ...(this.#hidden ? { hidden: true as const } : {}),
      };
    }

    /** The user's close goes through the app's `close` listeners. */
    protected override closeAsked() {
      this.close();
    }

    protected override resized(width: number, height: number) {
      const from = this.#size;
      this.#size = { height, width };
      for (const view of this.getBrowserViews()) {
        view.follow(from, this.#size);
      }
      this.emit("resize");
    }

    protected override wasClosed() {
      windows.delete(this.id);
      this.#holdParent();
      // Its children close with it, as Electron closes them.
      for (const child of this.getChildWindows()) {
        child.#parent = undefined;
        child.destroy();
      }
      this.#menu?.off("changed", this.#showMenuBar);
      // A popup up over the window closes with it, nothing chosen.
      const popups = [...this.#popups.values()];
      this.#popups.clear();
      for (const closed of popups) {
        closed(0);
      }
      // The engine lets go of the window's views; they live on unheld.
      for (const view of this.contentView.children) {
        view.holder = undefined;
        this.viewHeld(view, false);
      }
      this.emit("closed");
      if (windows.size === 0) {
        allClosed();
      }
    }
  }

  /** Whether `child` is `window`, or a child of it, however far down. */
  const descendsFrom = (
    child: BrowserWindow,
    window: BrowserWindow,
  ): boolean => {
    const parent = child.getParentWindow();
    return (
      child === window || (parent !== null && descendsFrom(parent, window))
    );
  };

  /** The window `parent` names, as `parent` and setParentWindow take it. */
  const parentWindow = (parent: unknown) => {
    if (parent === undefined || parent === null) {
      return undefined;
    } else if (parent instanceof BrowserWindow && !parent.isDestroyed()) {
      return parent;
    } else {
      throw new TypeError(
        "a window's parent is one of the app's open BrowserWindows",
      );
    }
  };

  /** Electron quits when the last window closes, unless the app listens. */
  const allClosed = () => {
    if (app.listenerCount("window-all-closed") > 0) {
      app.emit("window-all-closed");
    } else {
      app.quit();
    }
  };

  engine.events.on("window", (event) => {
    pages.get(event.window)?.take(event);
  });

  /** Electron's `webContents` module: the app's pages. */
  const webContents = {
    /** The page of `frame`, which is a page's main frame here. */
    fromFrame: (frame: WebFrameMain) => frame.page.webContents,
    fromId: (id: number) => pages.get(id)?.webContents,
    getAllWebContents: () =>
      [...pages.values()]
        .filter((page) => !page.isDestroyed())
        .map((page) => page.webContents),
    getFocusedWebContents: () =>
      [...pages.values()]
        .map((page) => page.webContents)
        .find((contents) => contents.isFocused()) ?? null,
  };

  /** Electron's `webFrameMain` module: each page's main frame, by its ids. */
  const webFrameMain = {
    fromFrameToken: (processId: number, frameToken: string) =>
      mainFrameWhere(
        (frame) =>
          frame.processId === processId && frame.frameToken === frameToken,
      ),
    fromId: (processId: number, routingId: number) =>
      mainFrameWhere(
        (frame) =>
          frame.processId === processId && frame.routingId === routingId,
      ),
  };
  const mainFrameWhere = (matches: (frame: WebFrameMain) => boolean) =>
    [...pages.values()]
      .filter((page) => page.webContents.pageState() !== undefined)
      .map((page) => page.webContents.mainFrame)
      .find(matches);

  return {
    BrowserView,
    BrowserWindow,
    WebContents,
    WebContentsView,
    WebFrameMain,
    webContents,
    /** The page the engine numbers `window`, a window's or a view's. */
    webContentsOf: (window: number) => pages.get(window)?.webContents,
    webFrameMain,
  };
};

type Windows = ReturnType<typeof createBrowserWindow>;
export type BrowserWindow = InstanceType<Windows["BrowserWindow"]>;
export type WebContentsView = InstanceType<Windows["WebContentsView"]>;
export type BrowserView = InstanceType<Windows["BrowserView"]>;

/**
 * A sandboxed page's preload: its own, or with its session's frame preloads
 * first, each in a function of its own as the engine runs one preload, and
 * each one's throw reported without stopping the next, as in Electron.
 */
const preloadSource = (
  readPreload: (path: string) => string,
  sessionPreloads: readonly string[],
  own: string | undefined,
) => {
  const paths = [...sessionPreloads, ...(own === undefined ? [] : [own])];
  if (sessionPreloads.length === 0) {
    return own === undefined ? undefined : readPreload(own);
  } else {
    return paths
      .map(
        (path) =>
          `try {\n(function (require, process, module, exports, global) {${readPreload(path)}\n}).call(this, require, process, module, exports, global);\n} catch (error) {\nsetTimeout(() => {\nthrow error;\n});\n}\n`,
      )
      .join("");
  }
};
