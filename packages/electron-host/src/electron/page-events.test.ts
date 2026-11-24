import { describe, expect, it } from "bun:test";
import { setUp } from "./browser-window-fixture";
import { PageEvents } from "./page-events";

/** A window that has opened its page, with what it sends from then on. */
const opened = () => {
  const fixture = setUp();
  const window = new fixture.BrowserWindow();
  void window.loadURL("https://notes.test/");
  fixture.sent.length = 0;
  return { ...fixture, window };
};

describe(PageEvents, () => {
  it("hands a page's console message to console-message, both ways", () => {
    const { say, window } = opened();
    const heard: unknown[][] = [];
    window.webContents.on("console-message", (...args: unknown[]) =>
      heard.push(args),
    );

    say({
      level: "warning",
      line: 7,
      message: "careful",
      source: "https://notes.test/app.js",
      type: "console_message",
      window: window.id,
    });

    expect(heard).toEqual([
      [
        expect.objectContaining({
          level: "warning",
          lineNumber: 7,
          message: "careful",
          sourceId: "https://notes.test/app.js",
        }),
        2,
        "careful",
        7,
        "https://notes.test/app.js",
      ],
    ]);
  });

  it("names the preload that threw, with its error", () => {
    const fixture = setUp();
    const window = new fixture.BrowserWindow({
      webPreferences: { preload: "/app/preload.js" },
    });
    void window.loadURL("https://notes.test/");
    const heard: unknown[][] = [];
    window.webContents.on("preload-error", (_event, path, error) =>
      heard.push([path, error]),
    );

    fixture.say({
      message: "x is not defined",
      name: "ReferenceError",
      stack: "ReferenceError: x is not defined\n    at preload.js:1",
      type: "preload_error",
      window: window.id,
    });

    expect(heard).toEqual([
      [
        "/app/preload.js",
        expect.objectContaining({
          message: "x is not defined",
          name: "ReferenceError",
        }),
      ],
    ]);
    expect(heard[0]?.[1]).toBeInstanceOf(Error);
  });

  it("tells the webContents and its window of a hung page and its return", () => {
    const { say, window } = opened();
    const heard: string[] = [];
    for (const name of ["unresponsive", "responsive"]) {
      window.on(name, () => heard.push(`window ${name}`));
      window.webContents.on(name, () => heard.push(`contents ${name}`));
    }

    say({ responsive: false, type: "responsive", window: window.id });
    say({ responsive: true, type: "responsive", window: window.id });

    expect(heard).toEqual([
      "contents unresponsive",
      "window unresponsive",
      "contents responsive",
      "window responsive",
    ]);
  });

  it("tells both of the page's own fullscreen", () => {
    const { say, window } = opened();
    const heard: string[] = [];
    for (const name of ["enter-html-full-screen", "leave-html-full-screen"]) {
      window.on(name, () => heard.push(`window ${name}`));
      window.webContents.on(name, () => heard.push(`contents ${name}`));
    }

    say({ fullscreen: true, type: "html_fullscreen", window: window.id });
    say({ fullscreen: false, type: "html_fullscreen", window: window.id });

    expect(heard).toEqual([
      "contents enter-html-full-screen",
      "window enter-html-full-screen",
      "contents leave-html-full-screen",
      "window leave-html-full-screen",
    ]);
  });

  it("says when the page's media plays and stops", () => {
    const { say, window } = opened();
    const heard: string[] = [];
    window.webContents.on("media-started-playing", () => heard.push("play"));
    window.webContents.on("media-paused", () => heard.push("pause"));

    say({ playing: true, type: "media_playing", window: window.id });
    say({ playing: false, type: "media_playing", window: window.id });

    expect(heard).toEqual(["play", "pause"]);
  });

  it("knows whether the page is audible, and says when that changes", () => {
    const { say, window } = opened();
    const heard: boolean[] = [];
    window.webContents.on("audio-state-changed", (event) =>
      heard.push(event.audible),
    );

    say({ audible: true, type: "audible", window: window.id });

    expect(heard).toEqual([true]);
    expect(window.webContents.isCurrentlyAudible()).toBe(true);
  });

  it("mutes the page and remembers it, from before it opens", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();

    window.webContents.setAudioMuted(true);
    void window.loadURL("https://notes.test/");
    window.webContents.audioMuted = false;

    expect(window.webContents.isAudioMuted()).toBe(false);
    expect(sent.slice(1)).toEqual([
      { muted: true, type: "set_audio_muted", window: window.id },
      { muted: false, type: "set_audio_muted", window: window.id },
    ]);
  });

  it("passes on the page's favicons, link, zoom and theme color", () => {
    const { say, window } = opened();
    const heard: unknown[][] = [];
    for (const name of [
      "page-favicon-updated",
      "update-target-url",
      "zoom-changed",
      "did-change-theme-color",
    ]) {
      window.webContents.on(name, (_event, ...args: unknown[]) =>
        heard.push([name, ...args]),
      );
    }

    say({ type: "favicons", urls: ["https://notes.test/f.ico"], window: 1 });
    say({ type: "target_url", url: "https://notes.test/b", window: 1 });
    say({ type: "zoom_asked", window: 1, zoom_in: false });
    say({ color: "#1A2B3C", type: "theme_color", window: 1 });
    say({ type: "theme_color", window: 1 });

    expect(heard).toEqual([
      ["page-favicon-updated", ["https://notes.test/f.ico"]],
      ["update-target-url", "https://notes.test/b"],
      ["zoom-changed", "out"],
      ["did-change-theme-color", "#1A2B3C"],
      ["did-change-theme-color", null],
    ]);
  });

  it("gives a custom cursor's picture, scale, size and hotspot", () => {
    const { say, window } = opened();
    const heard: unknown[][] = [];
    window.webContents.on("cursor-changed", (_event, ...args: unknown[]) =>
      heard.push(args),
    );
    // A 1x1 PNG.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    say({ cursor: "pointer", type: "cursor_changed", window: 1 });
    say({
      cursor: "custom",
      height: 1,
      hotspot_x: 0,
      hotspot_y: 1,
      image: png,
      scale: 2,
      type: "cursor_changed",
      width: 1,
      window: 1,
    });

    expect(heard).toEqual([
      ["pointer"],
      [
        "custom",
        expect.objectContaining({ getSize: expect.any(Function) }),
        2,
        { height: 1, width: 1 },
        { x: 0, y: 1 },
      ],
    ]);
  });

  it("passes on the page's preferred size and the bounds it asks for", () => {
    const { say, window } = opened();
    const heard: unknown[][] = [];
    for (const name of ["preferred-size-changed", "content-bounds-updated"]) {
      window.webContents.on(name, (_event, size) => heard.push([name, size]));
    }

    say({ height: 200, type: "preferred_size", width: 300, window: 1 });
    say({ height: 4, type: "content_bounds", width: 3, window: 1, x: 1, y: 2 });

    expect(heard).toEqual([
      ["preferred-size-changed", { height: 200, width: 300 }],
      ["content-bounds-updated", { height: 4, width: 3, x: 1, y: 2 }],
    ]);
  });

  it("asks for preferred sizes when its webPreferences do", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow({
      webPreferences: { enablePreferredSizeMode: true },
    });

    void window.loadURL("https://notes.test/");

    expect(sent.slice(1)).toEqual([
      { type: "enable_preferred_size_mode", window: window.id },
    ]);
  });

  it("listens for the page's keys only while the app does", () => {
    const { sent, window } = opened();
    const listener = () => undefined;

    window.webContents.on("before-input-event", listener);
    window.webContents.on("before-input-event", listener);
    window.webContents.off("before-input-event", listener);
    window.webContents.off("before-input-event", listener);

    expect(sent).toEqual([
      {
        events: false,
        keys: true,
        mouse: false,
        type: "listen_input",
        window: window.id,
      },
      {
        events: false,
        keys: false,
        mouse: false,
        type: "listen_input",
        window: window.id,
      },
    ]);
  });

  it("still hears new listeners after the app removes all of them", () => {
    const { sent, window } = opened();
    window.webContents.on("before-input-event", () => undefined);

    window.webContents.removeAllListeners();
    window.webContents.on("before-mouse-event", () => undefined);

    expect(
      sent.map((request) => request.type === "listen_input" && request),
    ).toEqual([
      {
        events: false,
        keys: true,
        mouse: false,
        type: "listen_input",
        window: window.id,
      },
      {
        events: false,
        keys: false,
        mouse: false,
        type: "listen_input",
        window: window.id,
      },
      {
        events: false,
        keys: false,
        mouse: true,
        type: "listen_input",
        window: window.id,
      },
    ]);
  });

  it("tells a page opened later what the app listens for", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();
    window.webContents.on("input-event", () => undefined);

    void window.loadURL("https://notes.test/");

    expect(sent.slice(1)).toEqual([
      {
        events: true,
        keys: false,
        mouse: false,
        type: "listen_input",
        window: window.id,
      },
    ]);
  });

  it("answers a held key with whether a listener prevented it", () => {
    const { say, sent, window } = opened();
    const keys: unknown[] = [];
    window.webContents.on("before-input-event", (event, input) => {
      keys.push(input);
      if (input.control) {
        event.preventDefault();
      }
    });
    sent.length = 0;

    say({
      ask: 4,
      input: {
        alt: false,
        code: "KeyW",
        control: true,
        is_auto_repeat: false,
        is_composing: false,
        key: "w",
        location: 0,
        meta: false,
        modifiers: ["control"],
        shift: false,
        type: "keyDown",
      },
      type: "before_input",
      window: window.id,
    });

    expect(keys).toEqual([
      {
        alt: false,
        code: "KeyW",
        control: true,
        isAutoRepeat: false,
        isComposing: false,
        key: "w",
        location: 0,
        meta: false,
        modifiers: ["control"],
        shift: false,
        type: "keyDown",
      },
    ]);
    expect(sent).toEqual([
      { ask: 4, prevent: true, type: "input_answer", window: window.id },
    ]);
  });

  it("answers a held key even when a listener throws", () => {
    const { say, sent, window } = opened();
    window.webContents.on("before-mouse-event", () => {
      throw new Error("the app's bug");
    });
    sent.length = 0;

    expect(() =>
      say({
        ask: 5,
        mouse: {
          click_count: 1,
          global_x: 10,
          global_y: 20,
          modifiers: [],
          movement_x: 0,
          movement_y: 0,
          type: "mouseDown",
          x: 10,
          y: 20,
        },
        type: "before_mouse",
        window: window.id,
      }),
    ).toThrow("the app's bug");
    expect(sent).toEqual([
      { ask: 5, prevent: false, type: "input_answer", window: window.id },
    ]);
  });

  it("names an input event's fields as Electron does", () => {
    const { say, window } = opened();
    const heard: unknown[] = [];
    window.webContents.on("input-event", (_event, input) => heard.push(input));

    say({
      event: {
        button: "left",
        click_count: 2,
        global_x: 1,
        global_y: 2,
        modifiers: ["shift"],
        movement_x: 0,
        movement_y: 0,
        type: "mouseUp",
        x: 1,
        y: 2,
      },
      type: "input_event",
      window: window.id,
    });

    expect(heard).toEqual([
      {
        button: "left",
        clickCount: 2,
        globalX: 1,
        globalY: 2,
        modifiers: ["shift"],
        movementX: 0,
        movementY: 0,
        type: "mouseUp",
        x: 1,
        y: 2,
      },
    ]);
  });

  it("sends input to the page by the engine's names", () => {
    const { sent, window } = opened();

    window.webContents.sendInputEvent({
      keyCode: "Tab",
      modifiers: ["Shift"],
      type: "keyDown",
    });
    window.webContents.sendInputEvent({
      clickCount: 1,
      type: "mouseDown",
      x: 3,
      y: 4,
    });

    expect(sent).toEqual([
      {
        event: { key_code: "Tab", modifiers: ["Shift"], type: "keyDown" },
        type: "send_input_event",
        window: window.id,
      },
      {
        event: { click_count: 1, type: "mouseDown", x: 3, y: 4 },
        type: "send_input_event",
        window: window.id,
      },
    ]);
  });

  it("throws for input that is no key or mouse event", () => {
    const { window } = opened();

    expect(() =>
      window.webContents.sendInputEvent({ type: "keyDown" }),
    ).toThrow("sendInputEvent's key needs its keyCode");
    expect(() =>
      window.webContents.sendInputEvent({ type: "touch" }),
    ).toThrow();
  });

  it("has a user agent of its own over its session's", () => {
    const { BrowserWindow, sent } = setUp();
    const window = new BrowserWindow();

    expect(window.webContents.getUserAgent()).toBe("Notes/1 Electron/45");
    window.webContents.setUserAgent("Mine/1");
    void window.loadURL("https://notes.test/");
    window.webContents.userAgent = "Mine/2";

    expect(window.webContents.getUserAgent()).toBe("Mine/2");
    expect(sent).toEqual([
      {
        title: "Notes",
        type: "open_window",
        url: "https://notes.test/",
        user_agent: "Mine/1",
        window: window.id,
      },
      { type: "set_page_user_agent", user_agent: "Mine/2", window: window.id },
    ]);
  });

  it("tells the engine to ignore the menu's shortcuts", () => {
    const { sent, window } = opened();

    window.webContents.setIgnoreMenuShortcuts(true);

    expect(sent).toEqual([
      { ignore: true, type: "set_ignore_menu_shortcuts", window: window.id },
    ]);
  });
});
