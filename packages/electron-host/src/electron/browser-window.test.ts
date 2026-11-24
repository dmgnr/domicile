import { describe, expect, it } from "bun:test";
import type { EngineRequest, WindowEvent } from "../engine";
import { createBrowserWindow } from "./browser-window";
import { contextMenuAt, setUp } from "./browser-window-fixture";
import type { MenuEntry } from "./menu";
import type { MessagePortMain } from "./message-port-main";
import { MessageChannelMain } from "./message-port-main";

describe(createBrowserWindow, () => {
  it("opens a window in the app's own session unless it names another", () => {
    const { BrowserWindow, sent, sessions } = setUp();
    const own = new BrowserWindow();
    const named = new BrowserWindow({
      webPreferences: { partition: "persist:cowork" },
    });
    const given = new BrowserWindow({
      webPreferences: { session: sessions.fromPartition("persist:cowork") },
    });

    void own.loadURL("https://notes.test/");
    void named.loadURL("https://notes.test/");
    void given.loadURL("https://notes.test/");

    expect(own.webContents.session).toBe(sessions.defaultSession);
    expect(named.webContents.session).toBe(
      sessions.fromPartition("persist:cowork"),
    );
    expect(given.webContents.session).toBe(named.webContents.session);
    expect(sent).toEqual([
      { scheme: "file", session: "persist:cowork", type: "handle_protocol" },
      {
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
      {
        session: "persist:cowork",
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 2,
      },
      {
        session: "persist:cowork",
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 3,
      },
    ]);
  });

  it("opens the window with its first page and loads the next in it", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();

    void window.loadURL("https://notes.test/");
    void window.loadURL("https://notes.test/b");

    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
      { type: "load_url", url: "https://notes.test/b", window: 1 },
    ]);
  });

  it("has Electron's older history methods, as its navigationHistory", () => {
    const { BrowserWindow } = setUp();
    const { webContents } = new BrowserWindow();

    expect(webContents.canGoBack()).toBe(
      webContents.navigationHistory.canGoBack(),
    );
    expect(webContents.canGoForward()).toBe(
      webContents.navigationHistory.canGoForward(),
    );
    expect(webContents.canGoToOffset(-1)).toBe(
      webContents.navigationHistory.canGoToOffset(-1),
    );
    expect(webContents.goBack).toBe(webContents.navigationHistory.goBack);
    expect(webContents.goForward).toBe(webContents.navigationHistory.goForward);
    expect(webContents.goToIndex).toBe(webContents.navigationHistory.goToIndex);
    expect(webContents.goToOffset).toBe(
      webContents.navigationHistory.goToOffset,
    );
    expect(webContents.clearHistory).toBe(webContents.navigationHistory.clear);
  });

  it("walks the page's history as the engine lists it", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    const history = window.webContents.navigationHistory;
    sent.length = 0;

    say({
      crashed: false,
      entries: [
        { title: "A", url: "https://a.test/" },
        { title: "B", url: "https://b.test/" },
        { title: "C", url: "https://c.test/" },
      ],
      focused: false,
      frame_token: "TOKEN",
      index: 1,
      loading: false,
      pid: 42,
      process_id: 5,
      routing_id: 3,
      type: "page_state",
      waiting: true,
      window: 1,
    });

    expect([history.length(), history.getActiveIndex()]).toEqual([3, 1]);
    expect([history.canGoBack(), history.canGoForward()]).toEqual([true, true]);
    expect(history.canGoToOffset(2)).toBe(false);
    expect(history.getEntryAtIndex(2)).toEqual({
      title: "C",
      url: "https://c.test/",
    });
    expect(history.getEntryAtIndex(3)).toBeNull();
    expect(window.webContents.getOSProcessId()).toBe(42);
    expect(window.webContents.getProcessId()).toBe(5);
    expect(window.webContents.isWaitingForResponse()).toBe(true);
    const frame = window.webContents.mainFrame;
    expect([
      frame.processId,
      frame.osProcessId,
      frame.routingId,
      frame.frameToken,
    ]).toEqual([5, 42, 3, "TOKEN"]);
    history.goBack();
    history.goToOffset(1);
    // Indexes the history doesn't have, and the one shown, do nothing.
    history.goToIndex(3);
    history.goToIndex(1);
    history.clear();
    expect(sent).toEqual([
      { index: 0, type: "go_to_index", window: 1 },
      { index: 2, type: "go_to_index", window: 1 },
      { type: "clear_history", window: 1 },
    ]);
  });

  it("tells the app when its page loads, takes focus or crashes", () => {
    const { BrowserWindow, say, webContents } = setUp();
    const first = new BrowserWindow();
    const second = new BrowserWindow();
    void first.loadURL("https://a.test/");
    void second.loadURL("https://b.test/");
    const heard: string[] = [];
    for (const name of [
      "did-start-loading",
      "did-stop-loading",
      "focus",
      "blur",
      "render-process-gone",
    ]) {
      first.webContents.on(name, () => heard.push(`page ${name}`));
    }
    first.on("focus", () => heard.push("window focus"));
    first.on("blur", () => heard.push("window blur"));
    const state = {
      crashed: false,
      entries: [{ title: "", url: "https://a.test/" }],
      focused: false,
      frame_token: "T",
      index: 0,
      loading: false,
      pid: 7,
      process_id: 4,
      routing_id: 1,
      type: "page_state" as const,
      waiting: false,
      window: 1,
    };

    expect(BrowserWindow.getFocusedWindow()).toBeNull();
    say({ ...state, loading: true });
    expect(first.webContents.isLoading()).toBe(true);
    say({ ...state, focused: true });
    expect(BrowserWindow.getFocusedWindow()).toBe(first);
    expect(webContents.getFocusedWebContents()).toBe(first.webContents);
    expect(first.isFocused()).toBe(true);
    say({ ...state, crashed: true });
    expect(first.webContents.isCrashed()).toBe(true);
    expect(BrowserWindow.getFocusedWindow()).toBeNull();
    expect(heard).toEqual([
      "page did-start-loading",
      "page did-stop-loading",
      "page focus",
      "window focus",
      "page blur",
      "window blur",
      "page render-process-gone",
    ]);
  });

  it("tells the app of each window it makes, and each that takes or loses focus", () => {
    const { app, BrowserWindow, say, WebContentsView } = setUp();
    const heard: unknown[] = [];
    for (const name of [
      "browser-window-created",
      "browser-window-focus",
      "browser-window-blur",
    ]) {
      app.on(name, (_event: unknown, window: unknown) =>
        heard.push(name, window),
      );
    }
    const window = new BrowserWindow();
    new WebContentsView();
    void window.loadURL("https://a.test/");
    const state = {
      crashed: false,
      entries: [{ title: "", url: "https://a.test/" }],
      focused: true,
      frame_token: "TOKEN",
      index: 0,
      loading: false,
      pid: 7,
      process_id: 4,
      routing_id: 3,
      type: "page_state" as const,
      waiting: false,
      window: 1,
    };

    say(state);
    say({ ...state, focused: false });

    expect(heard).toEqual([
      "browser-window-created",
      window,
      "browser-window-focus",
      window,
      "browser-window-blur",
      window,
    ]);
  });

  it("edits at the page's focus, as the Edit menu does", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    const contents = window.webContents;
    sent.length = 0;

    contents.undo();
    contents.redo();
    contents.cut();
    contents.copy();
    contents.paste();
    contents.pasteAndMatchStyle();
    contents.delete();
    contents.selectAll();
    contents.unselect();
    contents.centerSelection();
    contents.replace("cat");
    contents.replaceMisspelling("dog");
    expect(sent).toEqual([
      ...(
        [
          "undo",
          "redo",
          "cut",
          "copy",
          "paste",
          "paste_and_match_style",
          "delete",
          "select_all",
          "unselect",
          "center_selection",
        ] as const
      ).map((command) => ({ command, type: "edit" as const, window: 1 })),
      { misspelling: false, text: "cat", type: "replace", window: 1 },
      { misspelling: true, text: "dog", type: "replace", window: 1 },
    ]);
  });

  it("hears a context menu asked for over its page, in Electron's names", () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    const heard: unknown[] = [];
    window.webContents.on("context-menu", (_event, params) =>
      heard.push(params),
    );

    say(contextMenuAt(window.id));

    expect(heard).toEqual([
      {
        altText: "",
        dictionarySuggestions: ["the"],
        editFlags: {
          canCopy: true,
          canCut: false,
          canDelete: false,
          canEditRichly: false,
          canPaste: true,
          canRedo: false,
          canSelectAll: true,
          canUndo: false,
        },
        formControlType: "none",
        frame: window.webContents.mainFrame,
        frameCharset: "UTF-8",
        frameURL: "",
        hasImageContents: false,
        inputFieldType: "none",
        isEditable: true,
        linkText: "",
        linkURL: "",
        mediaFlags: {
          canLoop: false,
          canPrint: false,
          canRotate: false,
          canSave: false,
          canShowPictureInPicture: false,
          canToggleControls: false,
          hasAudio: false,
          inError: false,
          isControlsVisible: false,
          isLooping: false,
          isMuted: false,
          isPaused: false,
          isShowingPictureInPicture: false,
        },
        mediaType: "none",
        menuSourceType: "mouse",
        misspelledWord: "teh",
        pageURL: "https://a.test/",
        referrerPolicy: { policy: "default", url: "" },
        selectionRect: { height: 0, width: 0, x: 0, y: 0 },
        selectionStartOffset: 0,
        selectionText: "teh",
        spellcheckEnabled: true,
        srcURL: "",
        suggestedFilename: "",
        titleText: "",
        x: 10,
        y: 20,
      },
    ]);
  });

  it("hands a context menu over a subframe no frame, as it can't name one", () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    const frames: unknown[] = [];
    window.webContents.on("context-menu", (_event, params) =>
      frames.push(params.frame),
    );

    say({ ...contextMenuAt(window.id), frame_url: "https://b.test/" });

    expect(frames).toEqual([null]);
  });

  it("finds in the page, and says each search's last answer", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    const heard: unknown[] = [];
    window.webContents.on("found-in-page", (_event, result) =>
      heard.push(result),
    );
    sent.length = 0;

    const first = window.webContents.findInPage("cat");
    const second = window.webContents.findInPage("cat", {
      findNext: true,
      forward: false,
      matchCase: true,
    });
    window.webContents.stopFindInPage("keepSelection");
    say({
      active_match_ordinal: 2,
      matches: 3,
      request: second,
      selection: { height: 4, width: 3, x: 1, y: 2 },
      type: "found_in_page",
      window: 1,
    });

    expect([first, second]).toEqual([1, 2]);
    expect(sent).toEqual([
      {
        find_next: false,
        forward: true,
        match_case: false,
        request: 1,
        text: "cat",
        type: "find_in_page",
        window: 1,
      },
      {
        find_next: true,
        forward: false,
        match_case: true,
        request: 2,
        text: "cat",
        type: "find_in_page",
        window: 1,
      },
      { action: "keep_selection", type: "stop_find_in_page", window: 1 },
    ]);
    expect(heard).toEqual([
      {
        activeMatchOrdinal: 2,
        finalUpdate: true,
        matches: 3,
        requestId: 2,
        selectionArea: { height: 4, width: 3, x: 1, y: 2 },
      },
    ]);
  });

  it("refuses a search for nothing and a stop it can't do, as Electron does", () => {
    const { BrowserWindow } = setUp();
    const window = new BrowserWindow();

    expect(() => window.webContents.findInPage("")).toThrow(
      "Must provide a non-empty search content",
    );
    expect(() => window.webContents.stopFindInPage("forget" as never)).toThrow(
      "Invalid action for stopFindInPage",
    );
  });

  it("numbers windows from 1 and finds them by number", () => {
    const { BrowserWindow } = setUp();
    const first = new BrowserWindow();
    const second = new BrowserWindow();

    expect([first.id, second.id]).toEqual([1, 2]);
    expect(BrowserWindow.fromId(2)).toBe(second);
    expect(BrowserWindow.getAllWindows()).toEqual([first, second]);
  });

  it("loads a file of the app by its path from the app's root", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow().loadFile("dist/index.html");

    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "file:///cache/x/resources/app.asar/dist/index.html",
        window: 1,
      },
    ]);
  });

  it("resolves a load once its page loads, and is ready to show", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    const shown = new Promise((resolve) => window.on("ready-to-show", resolve));
    const finished = new Promise((resolve) =>
      window.webContents.on("did-finish-load", resolve),
    );

    const loading = window.loadURL("https://notes.test/");
    say({ type: "window_loaded", window: 1 });

    await loading;
    await shown;
    await finished;
    expect(window.isVisible()).toBe(true);
  });

  it("tells the app of each page as it makes it, as Electron's web-contents-created", () => {
    const { app, BrowserWindow, WebContentsView } = setUp();
    const created: unknown[] = [];
    app.on("web-contents-created", (event, webContents) => {
      created.push(event.sender, webContents);
    });

    const window = new BrowserWindow();
    const view = new WebContentsView();

    expect(created).toEqual([
      window.webContents,
      window.webContents,
      view.webContents,
      view.webContents,
    ]);
  });

  it("is dom-ready when the engine says its DOM is, before it finishes loading", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    const heard: string[] = [];
    window.webContents.on("dom-ready", () => heard.push("dom-ready"));
    window.webContents.on("did-finish-load", () =>
      heard.push("did-finish-load"),
    );

    const loading = window.loadURL("https://notes.test/");
    say({ type: "window_dom_ready", window: 1 });
    expect(heard).toEqual(["dom-ready"]);
    say({ type: "window_loaded", window: 1 });
    await loading;

    expect(heard).toEqual(["dom-ready", "did-finish-load"]);
  });

  it("rejects a load the engine refused, with why", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();

    const loading = window.loadURL("chrome://settings");
    say({ type: "window_refused", why: "no", window: 1 });

    await expect(loading).rejects.toThrow("no");
  });

  it("takes the page's title unless a listener prevents it", () => {
    const { BrowserWindow, say } = setUp();
    const kept = new BrowserWindow({ title: "Mine" });
    const taken = new BrowserWindow();
    kept.on("page-title-updated", (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );

    say({ title: "Page", type: "title_changed", window: 1 });
    say({ title: "Page", type: "title_changed", window: 2 });

    expect(kept.getTitle()).toBe("Mine");
    expect(taken.getTitle()).toBe("Page");
  });

  it("asks the engine to close an open window, and lets a close listener keep it", () => {
    const { BrowserWindow, sent } = setUp();
    const kept = new BrowserWindow();
    const closed = new BrowserWindow();
    void kept.loadURL("https://a.test/");
    void closed.loadURL("https://b.test/");
    kept.on("close", (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    sent.length = 0;

    kept.close();
    closed.close();

    expect(sent).toEqual([{ type: "close_window", window: 2 }]);
  });

  it("tells the engine the title the window shows, its own over its page's", () => {
    const { BrowserWindow, say, sent } = setUp();
    const kept = new BrowserWindow({ title: "Mine" });
    const taken = new BrowserWindow();
    kept.on("page-title-updated", (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    void kept.loadURL("https://a.test/");
    void taken.loadURL("https://b.test/");

    say({ title: "Page", type: "title_changed", window: 1 });
    say({ title: "Page", type: "title_changed", window: 2 });
    kept.setTitle("Still mine");

    expect(sent).toEqual([
      {
        title: "Mine",
        type: "open_window",
        url: "https://a.test/",
        window: 1,
      },
      {
        title: "Notes",
        type: "open_window",
        url: "https://b.test/",
        window: 2,
      },
      { title: "Page", type: "set_title", window: 2 },
      { title: "Still mine", type: "set_title", window: 1 },
    ]);
  });

  it("gives its contentView, its accessible title, and leaves stacking to the desktop", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    sent.length = 0;

    window.accessibleTitle = "Notes, 3 unread";
    window.moveTop();
    window.moveAbove("window:1:0");

    expect(window.getContentView()).toBe(window.contentView);
    expect(window.accessibleTitle).toBe("Notes, 3 unread");
    expect(new BrowserWindow().accessibleTitle).toBe("");
    expect(sent).toEqual([]);
  });

  it("puts the user's close to the app's close listeners", () => {
    const { BrowserWindow, say, sent } = setUp();
    const kept = new BrowserWindow();
    const closed = new BrowserWindow();
    void kept.loadURL("https://a.test/");
    void closed.loadURL("https://b.test/");
    kept.on("close", (event: { preventDefault: () => void }) => {
      event.preventDefault();
      kept.hide();
    });
    sent.length = 0;

    say({ type: "close_asked", window: 1 });
    say({ type: "close_asked", window: 2 });

    expect(sent).toEqual([
      { hidden: true, type: "set_hidden", window: 1 },
      { type: "close_window", window: 2 },
    ]);
    expect(kept.isDestroyed()).toBe(false);
  });

  it("hides and shows a window, which opens hidden with show: false", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow({ show: false });
    const heard: string[] = [];
    window.on("show", () => heard.push("show"));
    window.on("hide", () => heard.push("hide"));
    void window.loadURL("https://a.test/");
    say({ type: "window_loaded", window: 1 });

    expect(window.isVisible()).toBe(false);
    window.show();
    expect(window.isVisible()).toBe(true);
    window.show();
    window.hide();
    window.hide();
    expect(window.isVisible()).toBe(false);
    window.showInactive();

    expect(sent).toEqual([
      {
        hidden: true,
        title: "Notes",
        type: "open_window",
        url: "https://a.test/",
        window: 1,
      },
      { hidden: false, type: "set_hidden", window: 1 },
      { type: "focus_window", window: 1 },
      { type: "focus_window", window: 1 },
      { hidden: true, type: "set_hidden", window: 1 },
      { hidden: false, type: "set_hidden", window: 1 },
    ]);
    expect(heard).toEqual(["show", "hide", "show"]);
  });

  it("hides a window not yet open by opening it hidden", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();

    window.hide();
    void window.loadURL("https://a.test/");

    expect(sent).toEqual([
      {
        hidden: true,
        title: "Notes",
        type: "open_window",
        url: "https://a.test/",
        window: 1,
      },
    ]);
  });

  it("destroys without asking", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    window.on("close", (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    sent.length = 0;

    window.destroy();

    expect(sent).toEqual([{ type: "destroy_window", window: 1 }]);
  });

  it("is closed once the engine says so, and the app quits with its last window", () => {
    const { BrowserWindow, exits, say } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/").catch(() => undefined);
    let heard = false;
    window.on("closed", () => {
      heard = true;
    });

    say({ type: "window_closed", window: 1 });

    expect(heard).toBe(true);
    expect(window.isDestroyed()).toBe(true);
    expect(BrowserWindow.getAllWindows()).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it("leaves quitting to an app that listens for window-all-closed", () => {
    const { BrowserWindow, app, exits, say } = setUp();
    let heard = false;
    app.on("window-all-closed", () => {
      heard = true;
    });
    void new BrowserWindow().loadURL("https://a.test/").catch(() => undefined);

    say({ type: "window_closed", window: 1 });

    expect(heard).toBe(true);
    expect(exits).toEqual([]);
  });

  it("closes a window that never opened without the engine", () => {
    const { BrowserWindow, app, sent } = setUp();
    app.on("window-all-closed", () => undefined);
    const window = new BrowserWindow();

    window.close();

    expect(window.isDestroyed()).toBe(true);
    expect(sent).toEqual([]);
  });

  it("refuses to load in a destroyed window, as Electron does", () => {
    const { BrowserWindow, app } = setUp();
    app.on("window-all-closed", () => undefined);
    const window = new BrowserWindow();
    window.destroy();

    expect(() => window.loadURL("https://a.test/")).toThrow(
      "Object has been destroyed",
    );
  });
  it("opens a window with its preload's source", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow({
      webPreferences: { preload: "/app/preload.js" },
    }).loadURL("https://notes.test/");

    expect(sent).toEqual([
      {
        preload: "source of /app/preload.js",
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
    ]);
  });

  it("runs its session's frame preloads before its own, each as a preload of its own", () => {
    const { BrowserWindow, sent, sessions } = setUp();
    sessions.defaultSession.setPreloads(["/app/session.js"]);

    void new BrowserWindow({
      webPreferences: { preload: "/app/preload.js" },
    }).loadURL("https://notes.test/");
    void new BrowserWindow().loadURL("https://notes.test/");

    const each = (path: string) =>
      `try {\n(function (require, process, module, exports, global) {source of ${path}\n}).call(this, require, process, module, exports, global);\n} catch (error) {\nsetTimeout(() => {\nthrow error;\n});\n}\n`;
    expect(sent).toMatchObject([
      { preload: each("/app/session.js") + each("/app/preload.js") },
      { preload: each("/app/session.js") },
    ]);
  });

  it("hands a Node page in a session with frame preloads to its refuse", () => {
    const refused: string[] = [];
    const { BrowserWindow, sessions } = setUp({
      refuse: (why) => {
        refused.push(why);
        throw new Error("refused");
      },
    });
    sessions.defaultSession.setPreloads(["/app/session.js"]);

    expect(
      () => new BrowserWindow({ webPreferences: { sandbox: false } }),
    ).toThrow("refused");
    expect(refused).toEqual([
      "this window's session has preloads, which Domicile's engine runs only in a sandboxed page",
    ]);
  });

  it("gives a window's page its additionalArguments", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow({
      webPreferences: {
        additionalArguments: ["--desktop-features={}", "--x"],
        preload: "/app/preload.js",
      },
    }).loadURL("https://notes.test/");
    void new BrowserWindow({
      webPreferences: { additionalArguments: [] },
    }).loadURL("https://notes.test/");

    expect(sent[0]).toMatchObject({
      arguments: ["--desktop-features={}", "--x"],
      type: "open_window",
    });
    expect(sent[1]).not.toHaveProperty("arguments");
  });

  it("opens a window with nodeIntegration with Node.js in its page", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow({
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        preload: "/app/preload.js",
      },
    }).loadURL("https://notes.test/");

    expect(sent).toEqual([
      {
        node: {
          app_path: "/cache/x/resources/app.asar",
          context_isolation: false,
          env: { HOME: "/home/me" },
          integration: true,
          preload: "/app/preload.js",
        },
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
    ]);
  });

  it("gives an unsandboxed window's preload Node.js, isolated", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow({
      webPreferences: { preload: "/app/preload.js", sandbox: false },
    }).loadURL("https://notes.test/");

    expect(sent).toMatchObject([
      {
        node: {
          context_isolation: true,
          integration: false,
          preload: "/app/preload.js",
        },
        type: "open_window",
      },
    ]);
    expect(sent[0]).not.toHaveProperty("preload");
  });

  it("keeps a sandboxed window sandboxed, nodeIntegration or not", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow({
      webPreferences: { nodeIntegration: true, sandbox: true },
    }).loadURL("https://notes.test/");

    expect(sent[0]).not.toHaveProperty("node");
  });

  it("hands a sandboxed preload in the page's own world to its refuse", () => {
    const refused: string[] = [];
    const { BrowserWindow } = setUp({
      refuse: (why) => {
        refused.push(why);
        throw new Error("refused");
      },
    });

    expect(
      () => new BrowserWindow({ webPreferences: { contextIsolation: false } }),
    ).toThrow("refused");
    expect(refused).toEqual([
      "this window's sandboxed preload runs in its page's own world, which Domicile's engine doesn't give a preload",
    ]);
  });

  it("gives its page's send to ipcMain, from its webContents", () => {
    const { BrowserWindow, ipcMain, say } = setUp();
    const window = new BrowserWindow();
    const heard: unknown[] = [];
    ipcMain.on("save", (event: { sender: unknown }, ...args: unknown[]) =>
      heard.push(event.sender, ...args),
    );

    say({ args: [1], channel: "save", type: "ipc_message", window: 1 });

    expect(heard).toEqual([window.webContents, 1]);
  });

  it("answers its page's invoke with the handler's result or failure", async () => {
    const { BrowserWindow, ipcMain, say, sent } = setUp();
    void new BrowserWindow();
    ipcMain.handle("double", (_event, n) => Number(n) * 2);
    const answered = new Promise<void>((resolve) => {
      const count = sent.length;
      const check = () =>
        sent.length >= count + 2 ? resolve() : setTimeout(check, 1);
      check();
    });

    say({
      args: [2],
      channel: "double",
      invoke: 1,
      type: "ipc_invoke",
      window: 1,
    });
    say({
      args: [],
      channel: "none",
      invoke: 2,
      type: "ipc_invoke",
      window: 1,
    });
    await answered;

    // Each answers when its handler does, so in either order.
    expect(sent).toHaveLength(2);
    expect(sent).toContainEqual({ invoke: 1, result: 4, type: "ipc_reply" });
    expect(sent).toContainEqual({
      error: "No handler registered for 'none'",
      invoke: 2,
      type: "ipc_reply",
    });
  });

  it("sends to its page as JSON", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    window.webContents.send("ping", { at: new Date(0) }, undefined);

    expect(sent).toEqual([
      {
        args: [{ at: "1970-01-01T00:00:00.000Z" }, null],
        channel: "ping",
        type: "ipc_send",
        window: 1,
      },
    ]);
  });

  it("runs the app's script in its page once loaded, and resolves with what it gave", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    const title = window.webContents.executeJavaScript("document.title", true);
    const thrown = window.webContents.mainFrame.executeJavaScript("throw 1");
    // Electron waits for the page's load under way.
    await Bun.sleep(0);
    expect(sent).toEqual([]);
    say({ type: "window_loaded", window: 1 });
    await Bun.sleep(0);

    expect(sent).toEqual([
      {
        call: 1,
        code: "document.title",
        type: "execute_javascript",
        user_gesture: true,
        window: 1,
      },
      { call: 2, code: "throw 1", type: "execute_javascript", window: 1 },
    ]);
    say({ call: 2, error: "it threw", type: "javascript_result", window: 1 });
    say({ call: 1, result: "A", type: "javascript_result", window: 1 });
    expect(await title).toBe("A");
    await expect(thrown).rejects.toThrow("it threw");
  });

  it("rejects the app's script when its window closes first", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/").catch(() => undefined);

    const waiting = window.webContents.executeJavaScript("1");
    say({ type: "window_closed", window: 1 });

    await expect(waiting).rejects.toThrow("Object has been destroyed");
  });

  it("gives its main frame, the page's one frame, as a WebFrameMain", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/path");
    sent.length = 0;
    const frame = window.webContents.mainFrame;

    expect(window.webContents.mainFrame).toBe(frame);
    expect(frame.url).toBe("https://a.test/path");
    expect(frame.origin).toBe("https://a.test");
    expect(frame.top).toBe(frame);
    expect(frame.parent).toBeNull();
    expect(frame.framesInSubtree).toEqual([frame]);
    frame.send("ping", 1);
    expect(sent).toEqual([
      { args: [1], channel: "ping", type: "ipc_send", window: 1 },
    ]);
  });

  it("finds a page by its frame, and says whether it is a window's or a view's", () => {
    const { BrowserWindow, WebContentsView, webContents } = setUp();
    const window = new BrowserWindow();
    const view = new WebContentsView();

    expect(webContents.fromFrame(window.webContents.mainFrame)).toBe(
      window.webContents,
    );
    expect(window.webContents.getType()).toBe("window");
    expect(view.webContents.getType()).toBe("browserView");
  });

  it("focuses its page, and leaves blurring it to the desktop", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;

    window.focusOnWebView();
    window.blurWebView();

    expect(sent).toEqual([{ type: "focus_window", window: 1 }]);
  });

  it("drops what it sends before its page opens, as Electron has no page to give it", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow({ show: false });

    window.webContents.send("ready", 1);
    window.webContents.postMessage("port", { a: 1 });

    expect(sent).toEqual([]);
  });

  it("answers its page's sendSync with the returnValue a listener sets", async () => {
    const { BrowserWindow, ipcMain, say, sent } = setUp();
    void new BrowserWindow();
    const answered = new Promise<void>((resolve) => {
      ipcMain.on("triple", (event: { returnValue: unknown }, n: number) => {
        event.returnValue = n * 3;
        queueMicrotask(resolve);
      });
    });

    say({
      args: [3],
      channel: "triple",
      invoke: 4,
      type: "ipc_send_sync",
      window: 1,
    });
    await answered;
    await Promise.resolve();

    expect(sent).toEqual([{ invoke: 4, result: 9, type: "ipc_reply" }]);
  });

  it("posts to its page with ports, and carries what goes over them", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://a.test/");
    sent.length = 0;
    const { port1, port2 } = new MessageChannelMain();

    window.webContents.postMessage("port", { a: 1 }, [port2]);
    port1.postMessage(2);

    expect(sent).toEqual([
      {
        channel: "port",
        message: { a: 1 },
        ports: ["m1"],
        type: "ipc_post",
        window: 1,
      },
      { data: 2, port: "m1", type: "port_post", window: 1 },
    ]);
  });

  it("gives its page's postMessage to ipcMain with ports that end with the page", async () => {
    const { BrowserWindow, ipcMain, say } = setUp();
    void new BrowserWindow();
    const posted = new Promise<[MessagePortMain[], unknown]>((resolve) => {
      ipcMain.on(
        "mine",
        (event: { ports: MessagePortMain[] }, message: unknown) =>
          resolve([event.ports, message]),
      );
    });

    say({
      channel: "mine",
      message: "a port",
      ports: ["r1"],
      type: "ipc_post",
      window: 1,
    });
    const [[port], message] = await posted;
    const heard: unknown[] = [];
    port?.on("message", (event: { data: unknown }) => heard.push(event.data));
    port?.on("close", () => heard.push("closed"));
    port?.start();
    say({ data: 50, port: "r1", type: "port_message", window: 1 });
    say({ type: "page_gone", window: 1 });

    expect(message).toBe("a port");
    expect(heard).toEqual([50, "closed"]);
  });
});

describe("a page's new windows", () => {
  const asked = {
    ask: 3,
    disposition: "foreground-tab",
    features: "width=500,height=600",
    frame_name: "",
    referrer: "https://notes.test/",
    type: "window_open",
    url: "https://sign-in.test/",
    window: 1,
  } as const;

  it("asks the handler, and a denial opens nothing", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    const heard: unknown[] = [];
    window.webContents.setWindowOpenHandler((details) => {
      heard.push(details);
      return { action: "deny" };
    });
    sent.length = 0;

    say(asked);

    expect(heard).toEqual([
      {
        disposition: "foreground-tab",
        features: "width=500,height=600",
        frameName: "",
        postBody: undefined,
        referrer: {
          policy: "strict-origin-when-cross-origin",
          url: "https://notes.test/",
        },
        url: "https://sign-in.test/",
      },
    ]);
    expect(sent).toEqual([
      { action: "deny", ask: 3, type: "window_open_answer" },
    ]);
    expect(BrowserWindow.getAllWindows()).toEqual([window]);
  });

  it("opens an allowed window as a new BrowserWindow, as the opener's", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow({
      webPreferences: { partition: "persist:cowork" },
    });
    void window.loadURL("https://notes.test/");
    const created: unknown[] = [];
    window.webContents.on("did-create-window", (child: unknown) =>
      created.push(child),
    );
    window.webContents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: { title: "Sign in" },
    }));
    sent.length = 0;

    say(asked);

    const child = BrowserWindow.fromId(2);
    expect(created).toEqual([child]);
    expect(sent).toEqual([
      {
        action: "allow",
        ask: 3,
        session: "persist:cowork",
        title: "Sign in",
        type: "window_open_answer",
        window: 2,
      },
    ]);
    expect(child?.getSize()).toEqual([500, 600]);
  });

  it("opens the window with no handler, as Electron does", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    sent.length = 0;

    say(asked);

    expect(sent).toEqual([
      {
        action: "allow",
        ask: 3,
        title: "Notes",
        type: "window_open_answer",
        window: 2,
      },
    ]);
  });

  it("denies the window when the handler throws, and the app hears why", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    window.webContents.setWindowOpenHandler(() => {
      throw new Error("no");
    });
    sent.length = 0;

    expect(() => say(asked)).toThrow("no");
    expect(sent).toEqual([
      { action: "deny", ask: 3, type: "window_open_answer" },
    ]);
  });

  it("opens the window createWindow makes", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    window.webContents.setWindowOpenHandler(() => ({
      action: "allow",
      createWindow: (options) =>
        new BrowserWindow({ ...options, show: false }).webContents,
    }));
    sent.length = 0;

    say(asked);

    expect(sent).toEqual([
      {
        action: "allow",
        ask: 3,
        hidden: true,
        title: "Notes",
        type: "window_open_answer",
        window: 2,
      },
    ]);
  });
});

describe("a window's menu bar", () => {
  /** The set_menu_bar requests sent, without the rest. */
  const menuBars = (sent: readonly EngineRequest[]) =>
    sent.filter((request) => request.type === "set_menu_bar");

  const entry = (id: number, label: string): MenuEntry => ({
    checked: false,
    enabled: true,
    id,
    label,
    sublabel: "",
    toolTip: "",
    type: "normal",
    visible: true,
  });

  it("opens with the app's menu, right after the window", () => {
    const { BrowserWindow, menus, sent } = setUp();
    menus.Menu.setApplicationMenu(
      menus.Menu.buildFromTemplate([{ label: "New Note" }]),
    );
    const window = new BrowserWindow();

    void window.loadURL("https://notes.test/");

    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
      {
        auto_hide: false,
        menu: [entry(1, "New Note")],
        type: "set_menu_bar",
        visible: true,
        window: 1,
      },
    ]);
  });

  it("opens with no menu bar when the app has no menu", () => {
    const { BrowserWindow, sent } = setUp();

    void new BrowserWindow().loadURL("https://notes.test/");

    expect(menuBars(sent)).toEqual([]);
  });

  it("follows its menu as it changes, and the menu set in its place", () => {
    const { BrowserWindow, menus, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    const first = menus.Menu.buildFromTemplate([{ label: "New Note" }]);
    const second = menus.Menu.buildFromTemplate([{ label: "Open" }]);
    sent.length = 0;

    window.setMenu(first);
    first.append(new menus.MenuItem({ label: "Close" }));
    window.setMenu(second);
    first.append(new menus.MenuItem({ label: "Unseen" }));
    window.removeMenu();

    expect(menuBars(sent).map(({ menu }) => menu)).toEqual([
      [entry(1, "New Note")],
      [entry(1, "New Note"), entry(3, "Close")],
      [entry(2, "Open")],
      null,
    ]);
  });

  it("gives every window the menu the app sets", () => {
    const { BrowserWindow, menus, sent } = setUp();
    void new BrowserWindow().loadURL("https://notes.test/");
    void new BrowserWindow().loadURL("https://notes.test/");
    sent.length = 0;

    menus.Menu.setApplicationMenu(
      menus.Menu.buildFromTemplate([{ label: "New Note" }]),
    );

    expect(menuBars(sent).map(({ window }) => window)).toEqual([1, 2]);
  });

  it("hides the bar or keeps it until Alt, as the app asks", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow({ autoHideMenuBar: true });
    void window.loadURL("https://notes.test/");

    window.setMenuBarVisibility(false);
    window.setAutoHideMenuBar(false);

    expect(
      menuBars(sent).map(({ auto_hide, visible }) => ({ auto_hide, visible })),
    ).toEqual([
      { auto_hide: true, visible: false },
      { auto_hide: false, visible: false },
    ]);
    expect(window.isMenuBarVisible()).toBe(false);
    expect(window.isMenuBarAutoHide()).toBe(false);
  });

  it("has Electron's properties for it, as Element's settings read them", () => {
    const { BrowserWindow, menus, sent } = setUp();
    menus.Menu.setApplicationMenu(
      menus.Menu.buildFromTemplate([{ label: "New Note" }]),
    );
    const window = new BrowserWindow({ autoHideMenuBar: true });
    void window.loadURL("https://notes.test/");

    const autoHid = window.autoHideMenuBar;
    window.autoHideMenuBar = false;
    window.menuBarVisible = false;

    expect(autoHid).toBe(true);
    expect([window.autoHideMenuBar, window.menuBarVisible]).toEqual([
      false,
      false,
    ]);
    expect(
      menuBars(sent).map(({ auto_hide, visible }) => ({ auto_hide, visible })),
    ).toEqual([
      { auto_hide: true, visible: true },
      { auto_hide: false, visible: true },
      { auto_hide: false, visible: false },
    ]);
  });

  it("tells the engine nothing before the window opens", () => {
    const { BrowserWindow, menus, sent } = setUp();
    const window = new BrowserWindow();

    window.setMenu(menus.Menu.buildFromTemplate([{ label: "New Note" }]));
    window.setMenuBarVisibility(false);

    expect(sent).toEqual([]);
  });

  it("runs a clicked entry for the window whose bar was clicked", () => {
    const { BrowserWindow, menus, say } = setUp();
    const clicks: [string, unknown][] = [];
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    window.setMenu(
      menus.Menu.buildFromTemplate([
        {
          click: (item, clicked) => clicks.push([item.label, clicked]),
          label: "New Note",
        },
      ]),
    );

    say({ command: 1, type: "menu_clicked", window: 1 });

    expect(clicks).toEqual([["New Note", window]]);
  });
  it("is the focused window while an entry of its menu bar runs", () => {
    const { BrowserWindow, menus, say } = setUp();
    const focused: unknown[] = [];
    const window = new BrowserWindow();
    void window.loadURL("https://notes.test/");
    // As Claude's View > Full Screen, which acts on the focused window.
    window.setMenu(
      menus.Menu.buildFromTemplate([
        {
          click: () => focused.push(BrowserWindow.getFocusedWindow()),
          label: "Full Screen",
        },
      ]),
    );

    // The shell's menu has the keyboard, not the window's page.
    say({ command: 1, type: "menu_clicked", window: 1 });

    expect(focused).toEqual([window]);
    expect(BrowserWindow.getFocusedWindow()).toBeNull();
  });
});

describe("a window's popup menus", () => {
  /** The popup requests sent, without the rest. */
  const popupRequests = (sent: readonly EngineRequest[]) =>
    sent.filter(
      (request) =>
        request.type === "popup_menu" || request.type === "close_popup_menu",
    );

  it("asks the engine to draw the menu, and runs the entry chosen", () => {
    const { BrowserWindow, menus, say, sent } = setUp();
    const heard: unknown[] = [];
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    const menu = menus.Menu.buildFromTemplate([
      {
        click: (item, over) => heard.push([item.label, over]),
        label: "New Chat",
      },
    ]);

    menu.popup({ callback: () => heard.push("closed"), window, x: 4, y: 8 });
    const [asked] = popupRequests(sent);
    say({
      command: menu.items[0]?.commandId ?? 0,
      popup: 1,
      type: "popup_menu_closed",
      window: 1,
    });

    expect(asked).toMatchObject({
      popup: 1,
      type: "popup_menu",
      window: 1,
      x: 4,
      y: 8,
    });
    expect(heard).toEqual([["New Chat", window], "closed"]);
  });

  it("is the focused window while the entry chosen from it runs", () => {
    const { BrowserWindow, menus, say } = setUp();
    const focused: unknown[] = [];
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    // Claude hides its menu bar and pops the app's menu up from its own
    // title bar; its Full Screen acts on the focused window.
    const menu = menus.Menu.buildFromTemplate([
      {
        click: () => focused.push(BrowserWindow.getFocusedWindow()),
        label: "Full Screen",
      },
    ]);

    // The shell's popup has the keyboard, not the window's page.
    menu.popup({ window });
    say({
      command: menu.items[0]?.commandId ?? 0,
      popup: 1,
      type: "popup_menu_closed",
      window: 1,
    });

    expect(focused).toEqual([window]);
    expect(BrowserWindow.getFocusedWindow()).toBeNull();
  });

  it("asks the engine to put it away on closePopup", () => {
    const { BrowserWindow, menus, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    const menu = menus.Menu.buildFromTemplate([{ label: "New Chat" }]);

    menu.popup({ window });
    menu.closePopup(window);

    expect(popupRequests(sent).map(({ type }) => type)).toEqual([
      "popup_menu",
      "close_popup_menu",
    ]);
  });

  it("closes a popup with nothing chosen when its window closes", () => {
    const { BrowserWindow, menus, say } = setUp();
    const heard: string[] = [];
    const window = new BrowserWindow();
    // It never loads: the window closes first.
    window.loadURL("https://claude.test/").catch(() => undefined);
    const menu = menus.Menu.buildFromTemplate([
      { click: () => heard.push("clicked"), label: "New Chat" },
    ]);

    menu.popup({ callback: () => heard.push("closed"), window });
    say({ type: "window_closed", window: 1 });

    expect(heard).toEqual(["closed"]);
  });

  it("throws for a popup the engine closes that was never up", () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");

    expect(() => {
      say({ command: 0, popup: 3, type: "popup_menu_closed", window: 1 });
    }).toThrow("popup menu 3 of window 1, which was not up");
  });
});

describe("a window's state", () => {
  /** The set_window_state requests sent, without the rest. */
  const asked = (sent: readonly EngineRequest[]) =>
    sent.filter((request) => request.type === "set_window_state");

  /** The engine's word that the shell made window 1 `state`. */
  const shellMade = (
    say: (event: WindowEvent) => void,
    state: { maximized?: boolean; minimized?: boolean; fullscreen?: boolean },
  ) => {
    say({
      fullscreen: state.fullscreen ?? false,
      maximized: state.maximized ?? false,
      minimized: state.minimized ?? false,
      type: "window_state",
      window: 1,
    });
  };

  it("asks the shell, and reads as the shell says", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");

    window.maximize();
    window.setFullScreen(true);

    expect(asked(sent)).toEqual([
      {
        fullscreen: false,
        maximized: true,
        minimized: false,
        type: "set_window_state",
        window: 1,
      },
      {
        fullscreen: true,
        maximized: true,
        minimized: false,
        type: "set_window_state",
        window: 1,
      },
    ]);
    expect([window.isMaximized(), window.isFullScreen()]).toEqual([
      false,
      false,
    ]);
    shellMade(say, { fullscreen: true });
    expect([
      window.isMaximized(),
      window.isFullScreen(),
      window.isNormal(),
    ]).toEqual([false, true, false]);
  });

  it("tells the app of each change the shell makes", () => {
    const { BrowserWindow, say } = setUp();
    const heard: string[] = [];
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    for (const event of [
      "maximize",
      "unmaximize",
      "minimize",
      "restore",
      "enter-full-screen",
      "leave-full-screen",
    ]) {
      window.on(event, () => heard.push(event));
    }

    shellMade(say, { fullscreen: true, maximized: true });
    shellMade(say, { fullscreen: true, maximized: true });
    shellMade(say, { minimized: true });
    shellMade(say, {});

    expect(heard).toEqual([
      "maximize",
      "enter-full-screen",
      "unmaximize",
      "minimize",
      "leave-full-screen",
      "restore",
    ]);
  });

  it("asks once open for a window that starts fullscreen", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow({ fullscreen: true });

    expect(asked(sent)).toEqual([]);
    void window.loadURL("https://claude.test/");
    expect(asked(sent)).toMatchObject([{ fullscreen: true, window: 1 }]);
  });

  it("asks nothing of a window that can't be fullscreen", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow({ fullscreenable: false });
    void window.loadURL("https://claude.test/");

    window.setFullScreen(true);

    expect(asked(sent)).toEqual([]);
    expect(window.isFullScreenable()).toBe(false);
  });

  it("asks again for fullscreen after the user left it", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    window.setFullScreen(true);
    shellMade(say, { fullscreen: true });
    // The user left fullscreen with the shell, not the app. The shell acts
    // only on a change to what the app wants, so the engine must hear that
    // the app no longer wants it, or the app's next ask changes nothing.
    shellMade(say, {});

    window.setFullScreen(true);

    expect(asked(sent).map(({ fullscreen }) => fullscreen)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("asks nothing back of the state a window opens in", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow({ fullscreen: true });
    void window.loadURL("https://claude.test/");
    // The shell's first word, before it acts on the ask.
    shellMade(say, {});

    expect(asked(sent).map(({ fullscreen }) => fullscreen)).toEqual([true]);
  });

  it("starts the app's next ask from what the shell made the window", () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    void window.loadURL("https://claude.test/");
    window.setFullScreen(true);
    shellMade(say, { fullscreen: true });
    // The user took the window out of fullscreen.
    shellMade(say, {});

    window.maximize();

    expect(asked(sent).at(-1)).toMatchObject({
      fullscreen: false,
      maximized: true,
    });
  });
});
