import { describe, expect, it } from "bun:test";

import type { EngineRequest } from "../engine";
import { contextMenuAt, setUp } from "./browser-window-fixture";

/** Loads `url` in `page`, whose load a test may cut short by closing it. */
const load = (
  page: { loadURL: (url: string) => Promise<void> },
  url: string,
) => {
  page.loadURL(url).catch(() => undefined);
};

/** The views last placed in `window`, as the engine was told. */
const placed = (sent: readonly EngineRequest[], window: number) =>
  sent.findLast(
    (request) => request.type === "set_views" && request.window === window,
  );

describe("WebContentsView", () => {
  it("opens as a view once its page loads", () => {
    const { sent, WebContentsView } = setUp();
    const view = new WebContentsView();

    load(view.webContents, "https://notes.test/chat");

    expect(sent).toEqual([
      {
        type: "open_window",
        url: "https://notes.test/chat",
        view: true,
        window: 1,
      },
    ]);
  });

  it("opens with its preload and session", () => {
    const { sent, WebContentsView } = setUp();
    const view = new WebContentsView({
      webPreferences: { partition: "persist:chat", preload: "/app/chat.js" },
    });
    sent.length = 0;

    load(view.webContents, "https://notes.test/chat");

    expect(sent).toEqual([
      {
        preload: "source of /app/chat.js",
        session: "persist:chat",
        type: "open_window",
        url: "https://notes.test/chat",
        view: true,
        window: 1,
      },
    ]);
  });

  it("is placed in its window where the app puts it, bottom first", () => {
    const { BrowserWindow, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/title");
    const chat = new WebContentsView();
    const find = new WebContentsView();
    load(chat.webContents, "app://notes/chat");
    load(find.webContents, "app://notes/find");

    window.contentView.addChildView(chat);
    chat.setBounds({ height: 560, width: 800, x: 0, y: 40 });
    window.contentView.addChildView(find);
    find.setBounds({ height: 40, width: 200, x: 600, y: 40 });

    expect(window.contentView.children).toEqual([chat, find]);
    expect(chat.getBounds()).toEqual({ height: 560, width: 800, x: 0, y: 40 });
    expect(placed(sent, window.id)).toEqual({
      type: "set_views",
      views: [
        { height: 560, width: 800, window: chat.id, x: 0, y: 40 },
        { height: 40, width: 200, window: find.id, x: 600, y: 40 },
      ],
      window: window.id,
    });
  });

  it("focuses its window while its page has the keyboard", () => {
    const { BrowserWindow, say, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);
    const heard: string[] = [];
    window.on("focus", () => heard.push("focus"));
    window.on("blur", () => heard.push("blur"));
    const state = {
      crashed: false,
      entries: [{ title: "", url: "app://notes/chat" }],
      focused: true,
      frame_token: "T",
      index: 0,
      loading: false,
      pid: 7,
      process_id: 4,
      routing_id: 1,
      type: "page_state" as const,
      waiting: false,
      window: view.id,
    };

    // Claude's View > Full Screen acts on the focused window, whose page is
    // empty and whose views have the keyboard.
    say(state);
    expect(window.isFocused()).toBe(true);
    expect(BrowserWindow.getFocusedWindow()).toBe(window);
    say({ ...state, focused: false });
    expect(BrowserWindow.getFocusedWindow()).toBeNull();
    expect(heard).toEqual(["focus", "blur"]);
  });

  it("starts at no size, as Electron's does", () => {
    const { WebContentsView } = setUp();

    expect(new WebContentsView().getBounds()).toEqual({
      height: 0,
      width: 0,
      x: 0,
      y: 0,
    });
  });

  it("goes in at the index asked, and to the top when added again", () => {
    const { BrowserWindow, WebContentsView } = setUp();
    const window = new BrowserWindow();
    const [a, b, c] = [
      new WebContentsView(),
      new WebContentsView(),
      new WebContentsView(),
    ];

    window.contentView.addChildView(a);
    window.contentView.addChildView(b);
    window.contentView.addChildView(c, 0);
    expect(window.contentView.children).toEqual([c, a, b]);

    window.contentView.addChildView(c);
    expect(window.contentView.children).toEqual([a, b, c]);
  });

  it("stays placed while hidden, out of sight", () => {
    const { BrowserWindow, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);

    view.setVisible(false);

    expect(view.getVisible()).toBe(false);
    expect(placed(sent, window.id)).toEqual({
      type: "set_views",
      views: [
        { height: 0, hidden: true, width: 0, window: view.id, x: 0, y: 0 },
      ],
      window: window.id,
    });
  });

  it("is placed only once both it and its window are open", () => {
    const { BrowserWindow, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();
    window.contentView.addChildView(view);
    expect(sent).toEqual([]);

    load(window, "app://notes/");
    load(view.webContents, "app://notes/chat");

    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "app://notes/",
        window: window.id,
      },
      {
        type: "open_window",
        url: "app://notes/chat",
        view: true,
        window: view.id,
      },
      {
        type: "set_views",
        views: [{ height: 0, width: 0, window: view.id, x: 0, y: 0 }],
        window: window.id,
      },
    ]);
  });

  it("tells the engine nothing when nothing moved", () => {
    const { BrowserWindow, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);
    view.setBounds({ height: 10, width: 10, x: 0, y: 0 });
    const count = sent.length;

    view.setBounds({ height: 10, width: 10, x: 0, y: 0 });
    view.setVisible(true);

    expect(sent.length).toBe(count);
  });

  it("moves to another window that takes it, and leaves on removal", () => {
    const { BrowserWindow, sent, WebContentsView } = setUp();
    const first = new BrowserWindow();
    const second = new BrowserWindow();
    load(first, "app://notes/1");
    load(second, "app://notes/2");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    first.contentView.addChildView(view);

    second.contentView.addChildView(view);

    expect(first.contentView.children).toEqual([]);
    expect(placed(sent, first.id)).toEqual({
      type: "set_views",
      views: [],
      window: first.id,
    });
    expect(placed(sent, second.id)).toMatchObject({
      views: [{ window: view.id }],
    });

    second.contentView.removeChildView(view);

    expect(second.contentView.children).toEqual([]);
    expect(placed(sent, second.id)).toMatchObject({ views: [] });
  });

  it("outlives the window that held it, until the app closes its page", () => {
    const { BrowserWindow, say, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);

    say({ type: "window_closed", window: window.id });

    expect(view.webContents.isDestroyed()).toBe(false);
    expect(BrowserWindow.fromWebContents(view.webContents)).toBeNull();

    view.webContents.close();

    expect(sent.at(-1)).toEqual({ type: "destroy_window", window: view.id });
    say({ type: "window_closed", window: view.id });
    expect(view.webContents.isDestroyed()).toBe(true);
  });

  it("leaves its window when its page closes", () => {
    const { BrowserWindow, say, sent, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);

    say({ type: "window_closed", window: view.id });

    expect(window.contentView.children).toEqual([]);
    expect(placed(sent, window.id)).toMatchObject({ views: [] });
  });

  it("is no window: not listed, and not waited on to quit", () => {
    const { BrowserWindow, exits, say, WebContentsView } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const view = new WebContentsView();
    load(view.webContents, "app://notes/chat");
    window.contentView.addChildView(view);

    expect(BrowserWindow.getAllWindows()).toEqual([window]);
    expect(BrowserWindow.fromId(view.id)).toBeNull();

    say({ type: "window_closed", window: window.id });

    expect(exits).toEqual([0]);
  });

  it("tells the app when its bounds change, and only then", () => {
    const { WebContentsView } = setUp();
    const view = new WebContentsView();
    let changes = 0;
    view.on("bounds-changed", () => {
      changes += 1;
    });

    view.setBounds({ height: 10, width: 10, x: 0, y: 0 });
    view.setBounds({ height: 10, width: 10, x: 0, y: 0 });
    view.setBounds({ height: 20, width: 10, x: 0, y: 0 });

    expect(changes).toBe(2);
  });

  it("holds no views of its own, as only a window does on Domicile", () => {
    const { WebContentsView } = setUp();
    const view = new WebContentsView();

    expect(() => view.addChildView(new WebContentsView())).toThrow(
      "only a window's contentView holds views",
    );
  });

  it("hears its own page's IPC, as its webContents", () => {
    const { ipcMain, say, WebContentsView } = setUp();
    const view = new WebContentsView();
    const heard: unknown[] = [];
    ipcMain.on("ping", (event: { sender: unknown }) =>
      heard.push(event.sender),
    );

    say({ args: [], channel: "ping", type: "ipc_message", window: view.id });

    expect(heard).toEqual([view.webContents]);
  });

  it("hears a context menu over its own page, as its webContents", () => {
    const { say, WebContentsView } = setUp();
    const view = new WebContentsView();
    const heard: unknown[] = [];
    view.webContents.on(
      "context-menu",
      (_event: unknown, params: { selectionText: string }) =>
        heard.push(params.selectionText),
    );

    say({ ...contextMenuAt(view.id), selection_text: "cat" });

    expect(heard).toEqual(["cat"]);
  });

  it("finds its page's webContents by the engine's number", () => {
    const { BrowserWindow, webContentsOf, WebContentsView } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();

    expect(webContentsOf(window.id)).toBe(window.webContents);
    expect(webContentsOf(view.id)).toBe(view.webContents);
    expect(webContentsOf(99)).toBeUndefined();
  });
});

describe("BrowserWindow's size", () => {
  it("is what the app asked for until the shell gives the page one", () => {
    const { BrowserWindow } = setUp();
    const asked = new BrowserWindow({ height: 700, width: 1000 });
    const plain = new BrowserWindow();

    expect(asked.getContentBounds()).toEqual({
      height: 700,
      width: 1000,
      x: 0,
      y: 0,
    });
    expect(plain.getSize()).toEqual([800, 600]);
  });

  it("follows the shell's, and tells the app it resized", () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    let resizes = 0;
    window.on("resize", () => {
      resizes += 1;
    });

    say({ height: 900, type: "resized", width: 1400, window: window.id });

    expect(resizes).toBe(1);
    expect(window.getContentBounds()).toEqual({
      height: 900,
      width: 1400,
      x: 0,
      y: 0,
    });
    expect(window.getBounds()).toEqual(window.getContentBounds());
    expect(window.getSize()).toEqual([1400, 900]);
    expect(window.getContentSize()).toEqual([1400, 900]);
    expect(window.contentView.getBounds()).toEqual(window.getContentBounds());
  });
});

describe("BrowserWindow.fromWebContents", () => {
  it("finds the window of its own page, or of a view it holds", () => {
    const { BrowserWindow, WebContentsView } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();
    const loose = new WebContentsView();
    window.contentView.addChildView(view);

    expect(BrowserWindow.fromWebContents(window.webContents)).toBe(window);
    expect(BrowserWindow.fromWebContents(view.webContents)).toBe(window);
    expect(BrowserWindow.fromWebContents(loose.webContents)).toBeNull();
  });
});

describe("BrowserView", () => {
  it("is a window's one view with setBrowserView, and none with null", () => {
    const { BrowserView, BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    load(window, "app://notes/");
    const first = new BrowserView();
    const second = new BrowserView();
    load(first.webContents, "app://notes/a");
    load(second.webContents, "app://notes/b");

    window.setBrowserView(first);
    window.setBrowserView(second);
    expect(window.getBrowserView()).toBe(second);
    expect(window.getBrowserViews()).toEqual([second]);
    expect(placed(sent, window.id)).toMatchObject({
      views: [{ window: second.webContents.id }],
    });

    window.setBrowserView(null);
    expect(window.getBrowserView()).toBeNull();
    expect(placed(sent, window.id)).toMatchObject({ views: [] });
  });

  it("stacks with add, remove and setTop", () => {
    const { BrowserView, BrowserWindow } = setUp();
    const window = new BrowserWindow();
    const [a, b, c] = [new BrowserView(), new BrowserView(), new BrowserView()];

    window.addBrowserView(a);
    window.addBrowserView(b);
    window.addBrowserView(c);
    window.setTopBrowserView(a);
    expect(window.getBrowserViews()).toEqual([b, c, a]);

    window.removeBrowserView(c);
    expect(window.getBrowserViews()).toEqual([b, a]);
    expect(() => window.getBrowserView()).toThrow("more than one BrowserView");
    expect(BrowserWindow.fromBrowserView(a)).toBe(window);
  });

  it("grows with its window as its autoResize asks", () => {
    const { BrowserView, BrowserWindow, say } = setUp();
    const window = new BrowserWindow({ height: 600, width: 800 });
    load(window, "app://notes/");
    const sized = new BrowserView();
    const scaled = new BrowserView();
    const fixed = new BrowserView();
    window.addBrowserView(sized);
    window.addBrowserView(scaled);
    window.addBrowserView(fixed);
    sized.setBounds({ height: 560, width: 800, x: 0, y: 40 });
    scaled.setBounds({ height: 600, width: 400, x: 400, y: 0 });
    fixed.setBounds({ height: 10, width: 10, x: 0, y: 0 });
    sized.setAutoResize({ height: true, width: true });
    scaled.setAutoResize({ horizontal: true });

    say({ height: 700, type: "resized", width: 1000, window: window.id });

    expect(sized.getBounds()).toEqual({
      height: 660,
      width: 1000,
      x: 0,
      y: 40,
    });
    expect(scaled.getBounds()).toEqual({
      height: 600,
      width: 500,
      x: 500,
      y: 0,
    });
    expect(fixed.getBounds()).toEqual({ height: 10, width: 10, x: 0, y: 0 });
  });
});
