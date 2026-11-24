import { describe, expect, it } from "bun:test";

import { FakeDomicileHost } from "./fake-host";

describe("FakeDomicileHost", () => {
  it("lists a window that appeared, changed and closed, saying so each time", () => {
    const fake = new FakeDomicileHost();
    let changed = 0;
    fake.host.addEventListener("windowschanged", () => {
      changed += 1;
    });

    fake.appear("term", { title: "Terminal" });
    fake.change("term", { height: 480, width: 640 });
    fake.appear("menu", { parent: "term" });
    fake.close("menu");

    expect(fake.host.windows).toMatchObject([
      { appId: "term", height: 480, title: "Terminal", width: 640 },
    ]);
    expect(changed).toBe(4);
  });

  it("lists a window with no desktop id until one is given", () => {
    const fake = new FakeDomicileHost();

    fake.appear("term");
    fake.appear("files", { desktopId: "org.gnome.Nautilus" });

    expect(
      fake.host.windows.map(({ appId, desktopId }) => ({ appId, desktopId })),
    ).toStrictEqual([
      { appId: "term", desktopId: "" },
      { appId: "files", desktopId: "org.gnome.Nautilus" },
    ]);
  });

  it("lists a window with no owner until one is given", () => {
    const fake = new FakeDomicileHost();

    fake.appear("menu");
    fake.appear("term", { gid: 100, pid: 4242, pidfdInode: 5021, uid: 1000 });

    expect(
      fake.host.windows.map(({ gid, pid, pidfdInode, uid }) => ({
        gid,
        pid,
        pidfdInode,
        uid,
      })),
    ).toStrictEqual([
      { gid: null, pid: null, pidfdInode: null, uid: null },
      { gid: 100, pid: 4242, pidfdInode: 5021, uid: 1000 },
    ]);
  });

  it("lists a window with no sandbox until one is given", () => {
    const fake = new FakeDomicileHost();

    fake.appear("term");

    expect(fake.host.windows).toMatchObject([
      {
        sandboxAppId: null,
        sandboxEngine: null,
        sandboxed: null,
        sandboxInstanceId: null,
      },
    ]);
  });

  it("sets state and dispatches its change event", () => {
    const fake = new FakeDomicileHost();
    const heard: string[] = [];
    fake.host.addEventListener("idlechanged", () => {
      heard.push("idle");
    });
    fake.host.addEventListener("focusedwindowchanged", () => {
      heard.push("focus");
    });

    fake.set({ idle: true });
    fake.set({ focusedWindow: "term" });

    expect(fake.host.idle).toBe(true);
    expect(fake.host.focusedWindow).toBe("term");
    expect(heard).toStrictEqual(["idle", "focus"]);
  });

  it("records every call a shell makes", () => {
    const fake = new FakeDomicileHost();

    fake.host.spawn(["kitty"]);
    fake.host.focusApp("term");

    expect(fake.calls).toStrictEqual([
      ["spawn", ["kitty"]],
      ["focusApp", "term"],
    ]);
  });

  it("opens and closes browser windows as the engine does", () => {
    const fake = new FakeDomicileHost();
    let changed = 0;
    fake.host.addEventListener("browserwindowschanged", () => {
      changed += 1;
    });

    fake.host.openBrowserWindow("https://example.com");
    fake.openBrowser("chrome-extension://vault/popup.html", {
      popupWindow: 7,
    });
    fake.openBrowser("chrome-extension://notes/index.html", { isApp: true });
    fake.host.closeBrowserWindow("1");

    expect(fake.host.browserWindows).toMatchObject([
      {
        id: "2",
        isApp: false,
        popupWindow: 7,
        url: "chrome-extension://vault/popup.html",
      },
      { id: "3", isApp: true, url: "chrome-extension://notes/index.html" },
    ]);
    expect(fake.calls).toStrictEqual([
      ["openBrowserWindow", "https://example.com"],
      ["closeBrowserWindow", "1"],
    ]);
    expect(changed).toBe(4);
  });

  it("moves a browser window to another profile in place", () => {
    const fake = new FakeDomicileHost();
    fake.host.openBrowserWindow("https://example.com");
    fake.host.openBrowserWindow("https://docs.example.com");
    fake.host.reopenBrowserWindow("1", "work");

    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", profile: "work", url: "https://example.com" },
      { id: "2", profile: "default" },
    ]);
    expect(fake.calls.at(-1)).toStrictEqual([
      "reopenBrowserWindow",
      "1",
      "work",
    ]);
  });

  it("lists a browser window as captured while its capture runs", () => {
    const fake = new FakeDomicileHost();
    fake.host.openBrowserWindow("https://example.com");

    fake.captureBrowser("1");
    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", isCaptured: true },
    ]);

    fake.captureBrowser("1", false);
    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", isCaptured: false },
    ]);
  });

  it("opens private browser windows as the engine does", () => {
    const fake = new FakeDomicileHost();

    fake.host.openPrivateBrowserWindow("https://example.com");
    fake.host.openBrowserWindow("https://example.org");

    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", isPrivate: true, url: "https://example.com" },
      { id: "2", isPrivate: false, url: "https://example.org" },
    ]);
    expect(fake.calls).toStrictEqual([
      ["openPrivateBrowserWindow", "https://example.com"],
      ["openBrowserWindow", "https://example.org"],
    ]);
  });

  it("opens browser windows in a partition as the engine does", () => {
    const fake = new FakeDomicileHost();

    fake.host.openBrowserWindow("https://example.com", "persist:work");
    fake.host.openBrowserWindow("https://example.org");

    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", partition: "persist:work", url: "https://example.com" },
      { id: "2", partition: "", url: "https://example.org" },
    ]);
    expect(fake.calls).toStrictEqual([
      ["openBrowserWindow", "https://example.com", "persist:work"],
      ["openBrowserWindow", "https://example.org"],
    ]);
  });

  it("opens app windows as the engine does", () => {
    const fake = new FakeDomicileHost();

    fake.host.openAppWindow("https://music.example");

    expect(fake.host.browserWindows).toMatchObject([
      { id: "1", isApp: true, url: "https://music.example" },
    ]);
    expect(fake.calls).toStrictEqual([
      ["openAppWindow", "https://music.example"],
    ]);
  });

  it("reuses an app window with the same id, as the engine does", () => {
    const fake = new FakeDomicileHost();

    fake.host.openAppWindow("https://mail.example/", "mail");
    fake.host.openAppWindow("https://chat.example/", "chat", "focus");
    fake.host.openAppWindow("https://mail.example/", "mail", "focus");
    fake.host.openAppWindow("https://mail.example/t/1", "mail", "navigate");

    expect(fake.host.browserWindows).toMatchObject([
      { appId: "mail", id: "1", url: "https://mail.example/t/1" },
      { appId: "chat", id: "2", url: "https://chat.example/" },
    ]);
  });

  it("opens another app window with the same id for reuse new", () => {
    const fake = new FakeDomicileHost();

    fake.host.openAppWindow("https://mail.example/", "mail");
    fake.host.openAppWindow("https://mail.example/", "mail", "new");

    expect(fake.host.browserWindows).toMatchObject([
      { appId: "mail", id: "1" },
      { appId: "mail", id: "2" },
    ]);
  });

  it("records an ask and hands back a promise", () => {
    const fake = new FakeDomicileHost();

    const fetched = fake.host.fetchWithCookies(
      "https://example.com",
      "GET",
      [],
      null,
      null,
    );

    expect(fetched).toBeInstanceOf(Promise);
    expect(fake.calls).toStrictEqual([
      ["fetchWithCookies", "https://example.com", "GET", [], null, null],
    ]);
  });

  it("dispatches a moment with its fields", () => {
    const fake = new FakeDomicileHost();
    const chords: string[] = [];
    fake.host.addEventListener("shortcut", (event) => {
      chords.push(event.chord);
    });

    fake.dispatch("shortcut", { chord: "Meta+Return" });

    expect(chords).toStrictEqual(["Meta+Return"]);
  });
});
