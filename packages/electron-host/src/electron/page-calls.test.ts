import { describe, expect, it } from "bun:test";
import type { WindowEvent } from "../engine";
import { setUp } from "./browser-window-fixture";

/** What the engine says of window `window`'s page, with its frame's facts. */
const pageState = (
  window: number,
  facts: { focused?: boolean; process_id?: number; routing_id?: number } = {},
): WindowEvent => ({
  crashed: false,
  entries: [{ title: "", url: "https://a.test/" }],
  focused: facts.focused ?? false,
  frame_token: `TOKEN-${window}`,
  index: 0,
  loading: false,
  pid: 100 + window,
  process_id: facts.process_id ?? 4,
  routing_id: facts.routing_id ?? window,
  type: "page_state",
  waiting: false,
  window,
});

describe("page calls", () => {
  it("carries a call to the engine, numbered, and resolves with its result", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    const removed = window.webContents.removeInsertedCSS("j");
    const failed = window.webContents.removeInsertedCSS("k");
    say({ call: 2, error: "no", type: "page_result", window: 1 });
    say({ call: 1, result: null, type: "page_result", window: 1 });

    expect(await removed).toBeUndefined();
    await expect(failed).rejects.toThrow("no");
    expect(sent).toEqual([
      {
        call: 1,
        key: "j",
        method: "remove_inserted_css",
        type: "page_call",
        user: false,
        window: 1,
      },
      {
        call: 2,
        key: "k",
        method: "remove_inserted_css",
        type: "page_call",
        user: false,
        window: 1,
      },
    ]);
  });

  it("rejects a call on a page that hasn't opened, or that closes first", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();

    await expect(window.webContents.capturePage()).rejects.toThrow(
      "the page has opened nothing yet",
    );
    void window.loadURL("https://a.test/").catch(() => undefined);
    const waiting = window.webContents.removeInsertedCSS("k");
    say({ type: "window_closed", window: 1 });
    await expect(waiting).rejects.toThrow("the window closed");
  });

  it("sends the settings the app made before the page opened as it opens", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();

    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    window.setEnabled(false);
    expect(sent).toEqual([]);
    void window.loadURL("https://a.test/");

    expect(sent).toEqual([
      expect.objectContaining({ type: "open_window" }),
      {
        call: 1,
        method: "set_webrtc_ip_policy",
        policy: "disable_non_proxied_udp",
        type: "page_call",
        window: 1,
      },
      {
        call: 2,
        ignore: true,
        method: "set_ignore_input",
        type: "page_call",
        window: 1,
      },
    ]);
  });

  it("emulates its session's network conditions, set before and after it opens, until it closes", async () => {
    const { BrowserWindow, say, sent, sessions } = setUp();
    const slow = sessions.fromPartition("slow");
    slow.enableNetworkEmulation({ latency: 200 });
    const window = new BrowserWindow({ webPreferences: { session: slow } });
    const loaded = window.loadURL("https://a.test/");
    slow.enableNetworkEmulation({ offline: true });
    const emulated = sent.filter(
      (message) => "method" in message && message.method === "devtools",
    );
    say({ type: "window_closed", window: 1 });
    await expect(loaded).rejects.toThrow();
    sent.length = 0;
    slow.disableNetworkEmulation();

    expect(emulated).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ latency: 200, offline: false }),
        type: "page_call",
        window: 1,
      }),
      expect.objectContaining({
        params: expect.objectContaining({ latency: 0, offline: true }),
        type: "page_call",
        window: 1,
      }),
    ]);
    expect(sent).toEqual([]);
  });

  it("runs an isolated world's scripts after the load under way", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    const result = window.webContents.executeJavaScriptInIsolatedWorld(5, [
      { code: "1" },
    ]);
    await Bun.sleep(0);
    expect(sent).toEqual([]);
    say({ type: "window_loaded", window: 1 });
    await Bun.sleep(0);
    say({ call: 1, result: 1, type: "page_result", window: 1 });

    expect(await result).toBe(1);
    expect(sent).toEqual([
      {
        call: 1,
        method: "execute_in_isolated_world",
        scripts: [{ code: "1" }],
        type: "page_call",
        user_gesture: false,
        window: 1,
        world: 5,
      },
    ]);
  });

  it("hands the page's DevTools events to what drives them", () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    const frames: number[] = [];
    window.webContents.beginFrameSubscription((image) => {
      frames.push(image.getSize().width);
    });

    say({
      method: "Page.screencastFrame",
      params: {
        // A 1x1 PNG.
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        sessionId: 1,
      },
      type: "devtools_event",
      window: 1,
    });

    expect(frames).toEqual([1]);
  });

  it("captures a window as its page, and prints a frame as its page", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    const pdf = window.webContents.mainFrame.printToPDF({});
    say({
      call: 1,
      result: { data: "JVBERg==" },
      type: "page_result",
      window: 1,
    });
    expect((await pdf).toString()).toBe("%PDF");
    void window.capturePage().catch(() => undefined);
    window.webContents.mainFrame.copyVideoFrameAt(1, 2);

    expect(
      sent.map(
        (request) => "devtools_method" in request && request.devtools_method,
      ),
    ).toEqual(["Page.printToPDF", "Page.captureScreenshot", false]);
    expect(sent[2]).toEqual(
      expect.objectContaining({ method: "copy_video_frame_at", x: 1, y: 2 }),
    );
  });
});

describe("captures of what doesn't show", () => {
  it("captures a hidden window, or a view it doesn't show, as an empty image", async () => {
    const { BrowserWindow, WebContentsView, sent } = setUp();
    const window = new BrowserWindow({ show: false });
    const view = new WebContentsView();
    void window.loadURL("https://a.test/");
    void view.webContents.loadURL("https://b.test/");
    sent.length = 0;

    expect((await window.capturePage()).isEmpty()).toBe(true);
    expect((await view.webContents.capturePage()).isEmpty()).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("frames and pages", () => {
  it("names each page's type, as Electron does", () => {
    const { BrowserView, BrowserWindow, WebContentsView } = setUp();

    expect([
      new BrowserWindow().webContents.getType(),
      new WebContentsView().webContents.getType(),
      new BrowserView().webContents.getType(),
    ]).toEqual(["window", "browserView", "browserView"]);
  });

  it("finds a page by its frame, its frame by its ids, and its focused frame", () => {
    const { BrowserWindow, say, webContents, webFrameMain } = setUp();
    const first = new BrowserWindow();
    const second = new BrowserWindow();
    void first.loadURL("https://a.test/");
    void second.loadURL("https://b.test/");
    say(pageState(1, { focused: true, routing_id: 7 }));
    say(pageState(2, { routing_id: 9 }));

    expect(webContents.fromFrame(second.webContents.mainFrame)).toBe(
      second.webContents,
    );
    expect(webFrameMain.fromId(4, 7)).toBe(first.webContents.mainFrame);
    expect(webFrameMain.fromId(4, 8)).toBeUndefined();
    expect(webFrameMain.fromFrameToken(4, "TOKEN-2")).toBe(
      second.webContents.mainFrame,
    );
    expect(first.webContents.focusedFrame).toBe(first.webContents.mainFrame);
    expect(second.webContents.focusedFrame).toBeNull();
  });

  it("finds no frame of a page the engine hasn't told of yet", () => {
    const { BrowserWindow, webFrameMain } = setUp();
    void new BrowserWindow().loadURL("https://a.test/");

    expect(webFrameMain.fromId(0, 0)).toBeUndefined();
    expect(webFrameMain.fromFrameToken(0, "")).toBeUndefined();
  });

  it("sends to no frame before the engine tells of the page's", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    window.webContents.sendToFrame(0, "a");
    window.webContents.sendToFrame([0, 0], "b");

    expect(sent).toEqual([]);
  });

  it("inserts CSS after the load under way, as there's a document then", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    const inserted = window.webContents.insertCSS("a{}");
    await Bun.sleep(0);
    expect(sent).toEqual([]);
    say({ type: "window_loaded", window: 1 });
    await Bun.sleep(0);
    say({ call: 1, result: "k", type: "page_result", window: 1 });

    expect(await inserted).toBe("k");
    expect(sent).toEqual([expect.objectContaining({ method: "insert_css" })]);
  });

  it("sends to the main frame by its id, alone or with its renderer's", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    say(pageState(1, { process_id: 4, routing_id: 7 }));
    sent.length = 0;

    window.webContents.sendToFrame(7, "a", 1);
    window.webContents.sendToFrame([4, 7], "b");
    // A frame the host has no preload in, as without nodeIntegrationInSubFrames.
    window.webContents.sendToFrame([4, 8], "c");

    expect(sent).toEqual([
      { args: [1], channel: "a", type: "ipc_send", window: 1 },
      { args: [], channel: "b", type: "ipc_send", window: 1 },
    ]);
  });
});

describe("parents and modals", () => {
  it("keeps a window's parent and children, as the app set them", () => {
    const { BrowserWindow } = setUp();
    const parent = new BrowserWindow();
    const child = new BrowserWindow({ parent });
    const other = new BrowserWindow();

    expect(child.getParentWindow()).toBe(parent);
    expect(parent.getChildWindows()).toEqual([child]);
    expect(child.isModal()).toBe(false);
    child.setParentWindow(other);
    expect(parent.getChildWindows()).toEqual([]);
    expect(other.getChildWindows()).toEqual([child]);
    child.setParentWindow(null);
    expect(child.getParentWindow()).toBeNull();
    parent.setParentWindow(child);
    expect(() => child.setParentWindow(child)).toThrow(TypeError);
    expect(() => child.setParentWindow(parent)).toThrow(TypeError);
    expect(child.getParentWindow()).toBeNull();
  });

  it("refuses a parent that has closed", () => {
    const { BrowserWindow, say, webContents } = setUp();
    const parent = new BrowserWindow();
    parent.loadURL("https://a.test/").catch(() => undefined);
    say({ type: "window_closed", window: 1 });

    expect(() => new BrowserWindow({ modal: true, parent })).toThrow(TypeError);
    expect(BrowserWindow.getAllWindows()).toEqual([]);
    expect(webContents.getAllWebContents()).toEqual([]);
  });

  it("closes a window's children as it closes, as Electron does", () => {
    const { BrowserWindow, say, sent } = setUp();
    const parent = new BrowserWindow();
    const child = new BrowserWindow({ parent });
    parent.loadURL("https://a.test/").catch(() => undefined);
    child.loadURL("https://b.test/").catch(() => undefined);
    sent.length = 0;

    say({ type: "window_closed", window: 1 });

    expect(sent).toEqual([{ type: "destroy_window", window: 2 }]);
    expect(child.getParentWindow()).toBeNull();
  });

  it("takes input from a modal's parent while the modal shows", () => {
    const { BrowserWindow, say, sent } = setUp();
    const parent = new BrowserWindow();
    void parent.loadURL("https://a.test/");
    const modal = new BrowserWindow({ modal: true, parent, show: false });
    void modal.loadURL("https://b.test/").catch(() => undefined);
    sent.length = 0;

    expect(modal.isModal()).toBe(true);
    expect(parent.isEnabled()).toBe(true);
    modal.show();
    expect(parent.isEnabled()).toBe(false);
    say({ type: "window_closed", window: 2 });
    expect(parent.isEnabled()).toBe(true);
    expect(sent.filter((request) => request.type === "page_call")).toEqual([
      expect.objectContaining({
        ignore: true,
        method: "set_ignore_input",
        window: 1,
      }),
      expect.objectContaining({
        ignore: false,
        method: "set_ignore_input",
        window: 1,
      }),
    ]);
  });

  it("keeps input from a disabled window's views too", () => {
    const { BrowserWindow, WebContentsView, sent } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();
    window.contentView.addChildView(view);
    void window.loadURL("https://a.test/");
    void view.webContents.loadURL("https://b.test/");
    sent.length = 0;

    window.setEnabled(false);

    expect(window.isEnabled()).toBe(false);
    expect(sent.filter((request) => request.type === "page_call")).toEqual([
      expect.objectContaining({ ignore: true, window: 1 }),
      expect.objectContaining({ ignore: true, window: 2 }),
    ]);
  });

  it("lets a disabled window's view close", () => {
    const { BrowserWindow, WebContentsView, say } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();
    window.contentView.addChildView(view);
    void window.loadURL("https://a.test/");
    view.webContents.loadURL("https://b.test/").catch(() => undefined);
    window.setEnabled(false);
    const destroyed: unknown[] = [];
    view.webContents.on("destroyed", () => destroyed.push(view));

    say({ type: "window_closed", window: 2 });

    expect(destroyed).toEqual([view]);
    expect(window.contentView.children).toEqual([]);
  });

  it("gives a disabled window's views their input back as it closes", () => {
    const { BrowserWindow, WebContentsView, say, sent } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();
    window.contentView.addChildView(view);
    window.loadURL("https://a.test/").catch(() => undefined);
    void view.webContents.loadURL("https://b.test/");
    window.setEnabled(false);
    sent.length = 0;

    say({ type: "window_closed", window: 1 });

    expect(sent.filter((request) => request.type === "page_call")).toEqual([
      expect.objectContaining({ ignore: false, window: 2 }),
    ]);
  });
});
