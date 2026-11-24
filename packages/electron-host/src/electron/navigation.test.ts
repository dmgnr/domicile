import { describe, expect, it } from "bun:test";
import type { EventEmitter } from "node:events";
import type { WindowEvent, WireFrame } from "../engine";
import { setUp } from "./browser-window-fixture";

/** A window whose first page is loading, with what it sent forgotten. */
const opened = () => {
  const harness = setUp();
  const window = new harness.BrowserWindow();
  void window.loadURL("https://notes.test/").catch(() => undefined);
  harness.sent.length = 0;
  return { ...harness, window };
};

const main = { process: 4, routing: 1 } as const;
const sub = { process: 5, routing: 7 } as const;

/** The navigation keys of each of the engine's navigation events. */
const navigation = (
  url: string,
  {
    frame = main,
    initiator,
    sameDocument = false,
  }: {
    frame?: WireFrame;
    initiator?: WireFrame;
    sameDocument?: boolean;
  } = {},
) => ({
  frame,
  main_frame: frame === main,
  same_document: sameDocument,
  url,
  window: 1,
  ...(initiator === undefined ? {} : { initiator }),
});

/** Each emit of `names` on `emitter`, with its arguments. */
const heard = (emitter: EventEmitter, names: readonly string[]) => {
  const emitted: unknown[][] = [];
  for (const name of names) {
    emitter.on(name, (...args: unknown[]) => emitted.push([name, ...args]));
  }
  return emitted;
};

describe("a page's navigations", () => {
  it("start and redirect with Electron's details and arguments", () => {
    const { say, window } = opened();
    const emitted = heard(window.webContents, [
      "did-start-navigation",
      "did-redirect-navigation",
    ]);

    say({
      type: "navigation_started",
      ...navigation("https://notes.test/b", { initiator: main }),
    });
    say({
      type: "navigation_redirected",
      ...navigation("https://notes.test/c"),
    });

    const [started, redirected] = emitted;
    expect(started).toMatchObject([
      "did-start-navigation",
      {
        frame: window.webContents.mainFrame,
        initiator: window.webContents.mainFrame,
        isMainFrame: true,
        isSameDocument: false,
        url: "https://notes.test/b",
      },
      "https://notes.test/b",
      false,
      true,
      4,
      1,
    ]);
    expect(redirected).toMatchObject([
      "did-redirect-navigation",
      { initiator: null, url: "https://notes.test/c" },
      "https://notes.test/c",
      false,
      true,
      4,
      1,
    ]);
  });

  it("names the main frame by the engine's ids once it has said them", () => {
    const { say, window } = opened();

    say({ type: "navigation_started", ...navigation("https://notes.test/") });

    expect(window.webContents.mainFrame.processId).toBe(4);
    expect(window.webContents.mainFrame.routingId).toBe(1);
  });

  it("commits as did-navigate, did-frame-navigate or did-navigate-in-page", () => {
    const { say, window } = opened();
    const emitted = heard(window.webContents, [
      "did-navigate",
      "did-frame-navigate",
      "did-navigate-in-page",
    ]);

    say({
      http_response_code: 200,
      http_status_text: "OK",
      type: "navigation_committed",
      ...navigation("https://notes.test/b"),
    });
    say({
      http_response_code: -1,
      http_status_text: "",
      type: "navigation_committed",
      ...navigation("https://notes.test/b#c", { sameDocument: true }),
    });
    say({
      http_response_code: 404,
      http_status_text: "Not Found",
      type: "navigation_committed",
      ...navigation("https://ads.test/", { frame: sub }),
    });

    expect(emitted.map(([name, _event, ...rest]) => [name, ...rest])).toEqual([
      ["did-frame-navigate", "https://notes.test/b", 200, "OK", true, 4, 1],
      ["did-navigate", "https://notes.test/b", 200, "OK"],
      ["did-navigate-in-page", "https://notes.test/b#c", true, 4, 1],
      [
        "did-frame-navigate",
        "https://ads.test/",
        404,
        "Not Found",
        false,
        5,
        7,
      ],
    ]);
    expect(window.webContents.getURL()).toBe("https://notes.test/b#c");
  });

  it("gives a frame but the main frame as one the app can't script", () => {
    const { say, window } = opened();
    const frames: { url: string; processId: number; top: unknown }[] = [];
    window.webContents.on(
      "frame-created",
      (_event: unknown, details: { frame: (typeof frames)[number] }) =>
        frames.push(details.frame),
    );

    say({ frame: sub, main_frame: false, type: "frame_created", window: 1 });
    say({
      http_response_code: 200,
      http_status_text: "OK",
      type: "navigation_committed",
      ...navigation("https://ads.test/", { frame: sub }),
    });

    const [frame] = frames;
    expect(frame?.url).toBe("https://ads.test/");
    expect(frame?.processId).toBe(5);
    expect(frame?.top).toBe(window.webContents.mainFrame);
    expect(() =>
      (frame as unknown as { send: (channel: string) => void }).send("a"),
    ).toThrow("runs the app's scripts and IPC only in a page's main frame");

    say({
      http_response_code: 200,
      http_status_text: "OK",
      type: "navigation_committed",
      ...navigation("https://notes.test/next"),
    });
    expect(
      (frame as unknown as { isDestroyed: () => boolean }).isDestroyed(),
    ).toBe(true);
  });

  it("reports a frame's load, and the main frame's before did-finish-load", () => {
    const { say, window } = opened();
    const emitted = heard(window.webContents, [
      "did-frame-finish-load",
      "did-finish-load",
    ]);

    say({ type: "navigation_started", ...navigation("https://notes.test/") });
    say({ frame: sub, type: "frame_loaded", window: 1 });
    say({ type: "window_loaded", window: 1 });

    expect(emitted.map(([name, ...rest]) => [name, ...rest.slice(1)])).toEqual([
      ["did-frame-finish-load", false, 5, 7],
      ["did-frame-finish-load", true, 4, 1],
      ["did-finish-load"],
    ]);
  });
});

describe("a page's failed loads", () => {
  const failed = (
    errorCode: number,
    description: string,
    provisional: boolean,
  ): WindowEvent => ({
    error_code: errorCode,
    error_description: description,
    frame: main,
    main_frame: true,
    provisional,
    type: "load_failed",
    url: "https://notes.test/",
    window: 1,
  });

  it("fail provisionally, then did-fail-load unless aborted", () => {
    const { say, window } = opened();
    const emitted = heard(window.webContents, [
      "did-fail-provisional-load",
      "did-fail-load",
    ]);

    say(failed(-105, "ERR_NAME_NOT_RESOLVED", true));
    say(failed(-3, "ERR_ABORTED", true));
    say(failed(-2, "ERR_FAILED", false));

    expect(emitted.map(([name, _event, ...rest]) => [name, ...rest])).toEqual([
      [
        "did-fail-provisional-load",
        -105,
        "ERR_NAME_NOT_RESOLVED",
        "https://notes.test/",
        true,
        4,
        1,
      ],
      [
        "did-fail-load",
        -105,
        "ERR_NAME_NOT_RESOLVED",
        "https://notes.test/",
        true,
        4,
        1,
      ],
      [
        "did-fail-provisional-load",
        -3,
        "ERR_ABORTED",
        "https://notes.test/",
        true,
        4,
        1,
      ],
      ["did-fail-load", -2, "ERR_FAILED", "https://notes.test/", true, 4, 1],
    ]);
  });

  it("rejects the load under way as Electron's loadURL does", async () => {
    const { BrowserWindow, say } = setUp();
    const window = new BrowserWindow();
    const loading = window.loadURL("https://notes.test/");

    say(failed(-105, "ERR_NAME_NOT_RESOLVED", true));

    const error = await loading.then(
      () => undefined,
      (why: unknown) => why,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "ERR_NAME_NOT_RESOLVED",
      errno: -105,
      message: "ERR_NAME_NOT_RESOLVED (-105) loading 'https://notes.test/'",
      url: "https://notes.test/",
    });
  });
});

describe("the app's say over a page's navigations", () => {
  const asked = (redirect: boolean, frame: WireFrame = main): WindowEvent => ({
    ask: 9,
    redirect,
    type: "will_navigate",
    ...navigation("https://elsewhere.test/", { frame }),
  });

  /** What the app answered, without its word on whether it listens. */
  const answers = (sent: readonly unknown[]) =>
    sent.filter(
      (request) => (request as { type: string }).type !== "navigation_listen",
    );

  it("lets a navigation go when nothing prevents it", () => {
    const { say, sent } = opened();

    say(asked(false));

    expect(answers(sent)).toEqual([
      { ask: 9, proceed: true, type: "navigation_answer" },
    ]);
  });

  it("asks will-frame-navigate, then will-navigate, either of which stops it", () => {
    const { say, sent, window } = opened();
    const emitted = heard(window.webContents, [
      "will-frame-navigate",
      "will-navigate",
    ]);
    window.webContents.on(
      "will-navigate",
      (event: { preventDefault: () => void }) => event.preventDefault(),
    );

    say(asked(false));

    expect(emitted.map(([name, event]) => [name, event])).toMatchObject([
      ["will-frame-navigate", { url: "https://elsewhere.test/" }],
      ["will-navigate", { isMainFrame: true, url: "https://elsewhere.test/" }],
    ]);
    expect(answers(sent)).toEqual([
      { ask: 9, proceed: false, type: "navigation_answer" },
    ]);
  });

  it("asks only will-frame-navigate of a frame but the main frame", () => {
    const { say, sent, window } = opened();
    const emitted = heard(window.webContents, [
      "will-frame-navigate",
      "will-navigate",
    ]);
    window.webContents.on(
      "will-frame-navigate",
      (event: { preventDefault: () => void }) => event.preventDefault(),
    );

    say(asked(false, sub));

    expect(emitted.map(([name]) => name)).toEqual(["will-frame-navigate"]);
    expect(answers(sent)).toEqual([
      { ask: 9, proceed: false, type: "navigation_answer" },
    ]);
  });

  it("asks will-redirect of a redirect", () => {
    const { say, sent, window } = opened();
    const emitted = heard(window.webContents, ["will-redirect"]);
    window.webContents.on(
      "will-redirect",
      (event: { preventDefault: () => void }) => event.preventDefault(),
    );

    say(asked(true));

    expect(emitted).toMatchObject([
      [
        "will-redirect",
        { url: "https://elsewhere.test/" },
        "https://elsewhere.test/",
        false,
        true,
        4,
        1,
      ],
    ]);
    expect(answers(sent)).toEqual([
      { ask: 9, proceed: false, type: "navigation_answer" },
    ]);
  });

  it("lets the navigation go, and throws, when a listener throws", () => {
    const { say, sent, window } = opened();
    window.webContents.on("will-navigate", () => {
      throw new Error("the listener broke");
    });

    expect(() => say(asked(false))).toThrow("the listener broke");
    expect(answers(sent)).toEqual([
      { ask: 9, proceed: true, type: "navigation_answer" },
    ]);
  });

  it("keeps the page unless will-prevent-unload is prevented", () => {
    const { say, sent, window } = opened();

    say({ ask: 2, type: "will_prevent_unload", window: 1 });
    window.webContents.on(
      "will-prevent-unload",
      (event: { preventDefault: () => void }) => event.preventDefault(),
    );
    say({ ask: 3, type: "will_prevent_unload", window: 1 });

    expect(answers(sent)).toEqual([
      { ask: 2, type: "unload_answer", unload: false },
      { ask: 3, type: "unload_answer", unload: true },
    ]);
  });
});

describe("the engine's word on whether the app listens", () => {
  it("tells it once a will-navigate kind of listener comes and once the last goes", () => {
    const { sent, window } = opened();
    const listener = () => undefined;

    window.webContents.on("will-navigate", listener);
    window.webContents.on("will-redirect", listener);
    window.webContents.off("will-navigate", listener);
    window.webContents.on("did-navigate", listener);
    window.webContents.off("will-redirect", listener);

    expect(sent).toEqual([
      { listening: true, type: "navigation_listen", window: 1 },
      { listening: false, type: "navigation_listen", window: 1 },
    ]);
  });

  it("still hears of will-navigate listeners after the app removes its newListener ones", () => {
    const { sent, window } = opened();
    const listener = () => undefined;

    window.webContents.removeAllListeners("newListener");
    window.webContents.on("will-navigate", listener);
    window.webContents.removeAllListeners("removeListener");
    window.webContents.off("will-navigate", listener);

    expect(sent).toEqual([
      { listening: true, type: "navigation_listen", window: 1 },
      { listening: false, type: "navigation_listen", window: 1 },
    ]);
  });

  it("tells it as the page opens of a listener from before", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    window.webContents.on("will-frame-navigate", () => undefined);

    void window.loadURL("https://notes.test/");

    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        window: 1,
      },
      { listening: true, type: "navigation_listen", window: 1 },
    ]);
  });
});

describe("a page's history", () => {
  it("removes an entry it has and doesn't show", () => {
    const { say, sent, window } = opened();
    say({
      crashed: false,
      entries: [
        { title: "A", url: "https://a.test/" },
        { title: "B", url: "https://b.test/" },
      ],
      focused: false,
      frame_token: "",
      index: 1,
      loading: false,
      pid: 42,
      process_id: 0,
      routing_id: 0,
      type: "page_state",
      waiting: false,
      window: 1,
    });
    const history = window.webContents.navigationHistory;

    expect(history.removeEntryAtIndex(1)).toBe(false);
    expect(history.removeEntryAtIndex(2)).toBe(false);
    expect(history.removeEntryAtIndex(0)).toBe(true);
    expect(sent).toEqual([
      { index: 0, type: "remove_history_entry", window: 1 },
    ]);
  });

  it("restores a history into a page that hasn't loaded, at its newest entry", async () => {
    const { BrowserWindow, say, sent } = setUp();
    const window = new BrowserWindow();
    const entries = [
      { title: "A", url: "https://a.test/" },
      { title: "B", url: "https://b.test/" },
    ];

    const restored = window.webContents.navigationHistory.restore({ entries });
    say({ type: "window_loaded", window: 1 });
    await restored;

    expect(sent).toEqual([
      {
        history: { entries, index: 1 },
        title: "Notes",
        type: "open_window",
        url: "https://b.test/",
        window: 1,
      },
    ]);
  });

  it("restores only into a page that hasn't loaded, and only an entry it has", () => {
    const { BrowserWindow } = setUp();
    const window = new BrowserWindow();
    const entries = [{ title: "A", url: "https://a.test/" }];

    expect(() =>
      window.webContents.navigationHistory.restore({ entries, index: 1 }),
    ).toThrow("Invalid index");
    void window.loadURL("https://notes.test/");
    expect(() =>
      window.webContents.navigationHistory.restore({ entries }),
    ).toThrow("no existing history entries");
  });
});
