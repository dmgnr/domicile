import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { AppReuse } from "./browser";
import { desktop } from "./desktop";

describe("browser", () => {
  it("lists nothing until the browser has", () => {
    expect(
      desktop(new FakeDomicileHost().host).browser.windows,
    ).toBeUndefined();
  });

  it("lists each browser window with undefined for no popup window", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("https://example.com/");

    expect(desktop(fake.host).browser.windows).toStrictEqual([
      {
        appId: "",
        height: 0,
        id: "1",
        isApp: false,
        isCaptured: false,
        isHidden: false,
        isPrivate: false,
        menu: undefined,
        menuBarAutoHide: false,
        menuBarVisible: true,
        messageBox: undefined,
        parent: undefined,
        partition: "",
        popupMenu: undefined,
        popupWindow: undefined,
        profile: "default",
        title: "",
        toplevelId: undefined,
        url: "https://example.com/",
        wantsFullscreen: false,
        wantsMaximized: false,
        wantsMinimized: false,
        width: 0,
        x: 0,
        y: 0,
      },
    ]);
  });

  it("lists an Electron app's views apart from the windows", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("https://a.example/", { isApp: true });
    fake.openBrowser("https://b.example/", {
      height: 560,
      parent: "1",
      width: 800,
      x: 0,
      y: 40,
    });
    const { browser } = desktop(fake.host);

    expect(browser.windows?.map(({ id }) => id)).toEqual(["1"]);
    expect(
      browser.views?.map(({ id, parent, x, y, width, height }) => ({
        height,
        id,
        parent,
        width,
        x,
        y,
      })),
    ).toEqual([{ height: 560, id: "2", parent: "1", width: 800, x: 0, y: 40 }]);
    // The same lists until the browser lists again, as a React store needs.
    expect(browser.windows).toBe(browser.windows);
    expect(browser.views).toBe(browser.views);
  });

  it("lists no views until the browser has", () => {
    expect(desktop(new FakeDomicileHost().host).browser.views).toBeUndefined();
  });

  it("opens and closes browser windows", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    browser.open("https://a.example/");
    browser.open("https://b.example/", { partition: "persist:work" });
    browser.openPrivate("https://c.example/");
    browser.openApp("https://d.example/");
    browser.close("1");
    browser.clickMenu("2", 7);
    browser.answerMessageBox("2", 1, true);
    browser.answerPopupMenu("2", 3);
    browser.setWindowState("2", {
      fullscreen: true,
      maximized: false,
      minimized: false,
    });

    expect(fake.calls).toStrictEqual([
      ["openBrowserWindow", "https://a.example/", "", ""],
      ["openBrowserWindow", "https://b.example/", "persist:work", ""],
      ["openPrivateBrowserWindow", "https://c.example/"],
      ["openAppWindow", "https://d.example/", "", "new", ""],
      ["closeBrowserWindow", "1"],
      ["clickBrowserWindowMenu", "2", 7],
      ["answerBrowserWindowMessageBox", "2", 1, true],
      ["answerBrowserWindowPopupMenu", "2", 3],
      ["setBrowserWindowState", "2", false, false, true],
    ]);
  });

  it("opens a window in a profile and moves one to another", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    browser.open("https://a.example/", { profile: "work" });
    browser.reopen("1", "personal");
    browser.profileFor("https://b.example/").catch(() => {
      /* never answered */
    });

    expect(fake.calls).toStrictEqual([
      ["openBrowserWindow", "https://a.example/", "", "work"],
      ["reopenBrowserWindow", "1", "personal"],
      ["browserProfileFor", "https://b.example/"],
    ]);
    expect(browser.windows?.map(({ profile }) => profile)).toEqual([
      "personal",
    ]);
  });

  it("lists the browser profiles and says when they change", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    let changes = 0;
    const stop = browser.on("profilesChange", () => {
      changes += 1;
    });
    expect(browser.profiles).toBeUndefined();
    const work = {
      color: "#3366ff",
      configSites: [],
      enabledExtensions: [],
      extensions: [],
      id: "work",
      isDefault: true,
      isDefaultPrivate: false,
      isPrivate: false,
      lockedExtensions: [],
      name: "Work",
      pinnedSites: [],
    };
    fake.set({ browserProfiles: [work] });

    expect(browser.profiles).toStrictEqual([work]);
    expect(changes).toBe(1);
    stop();
  });

  it("pins a site to a profile and finds the site that routes an address", async () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    const profile = (
      id: string,
      isDefault: boolean,
      configSites: string[],
    ) => ({
      color: "#3366ff",
      configSites,
      enabledExtensions: [],
      extensions: [],
      id,
      isDefault,
      isDefaultPrivate: false,
      isPrivate: false,
      lockedExtensions: [],
      name: id,
      pinnedSites: [],
    });
    fake.set({
      browserProfiles: [
        profile("personal", true, []),
        profile("work", false, ["*.acme.com"]),
      ],
    });

    await browser.pin("github.com/acme", "work");
    expect(await browser.siteFor("https://github.com/acme/repo")).toBe(
      "github.com/acme",
    );
    expect(await browser.siteFor("https://docs.acme.com/")).toBe("*.acme.com");
    expect(await browser.siteFor("https://github.com/")).toBeUndefined();
    // The default profile unpins it.
    await browser.pin("github.com/acme", "personal");
    expect(browser.profiles?.map(({ pinnedSites }) => pinnedSites)).toEqual([
      [],
      [],
    ]);
    // Only the config moves its own sites.
    await expect(browser.pin("*.acme.com", "personal")).rejects.toThrow(
      "only the config",
    );
    expect(fake.calls[0]).toStrictEqual([
      "pinBrowserSite",
      "github.com/acme",
      "work",
    ]);
  });

  it("switches an extension in a profile, but not one the config switches", async () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    const BITWARDEN = "nngceckbapebfimnlniiiahkandclblb";
    const ONE_PASSWORD = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
    fake.set({
      browserProfiles: [
        {
          color: "#3366ff",
          configSites: [],
          enabledExtensions: [ONE_PASSWORD],
          extensions: [BITWARDEN, ONE_PASSWORD],
          id: "work",
          isDefault: true,
          isDefaultPrivate: false,
          isPrivate: false,
          lockedExtensions: [ONE_PASSWORD],
          name: "Work",
          pinnedSites: [],
        },
      ],
    });

    await browser.setExtensionEnabled("work", BITWARDEN, true);
    expect(browser.profiles?.[0]?.enabledExtensions).toEqual([
      ONE_PASSWORD,
      BITWARDEN,
    ]);
    await expect(
      browser.setExtensionEnabled("work", ONE_PASSWORD, false),
    ).rejects.toThrow("only the config");
    expect(fake.calls[0]).toStrictEqual([
      "setBrowserProfileExtensionEnabled",
      "work",
      BITWARDEN,
      true,
    ]);
  });

  it("opens an app window in a profile", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    browser.openApp("https://mail.example/", { profile: "work" });

    expect(fake.calls).toStrictEqual([
      ["openAppWindow", "https://mail.example/", "", "new", "work"],
    ]);
    expect(browser.windows?.map(({ profile }) => profile)).toEqual(["work"]);
  });

  it("opens an app window with an id, reusing the open one as asked", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    browser.openApp("https://mail.example/", { id: "mail" });
    browser.openApp("https://mail.example/", {
      id: "mail",
      reuse: AppReuse.Focus,
    });
    browser.openApp("https://mail.example/t/1", {
      id: "mail",
      reuse: AppReuse.Navigate,
    });

    expect(fake.calls).toStrictEqual([
      ["openAppWindow", "https://mail.example/", "mail", "new", ""],
      ["openAppWindow", "https://mail.example/", "mail", "focus", ""],
      ["openAppWindow", "https://mail.example/t/1", "mail", "navigate", ""],
    ]);
  });

  it("counts matches in a window's page", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .browser.countMatches("1", "p.unread")
      .catch(() => {
        /* never answered */
      });

    expect(fake.calls).toStrictEqual([
      ["countBrowserWindowMatches", "1", "p.unread"],
    ]);
  });

  it("clicks a match in a window's page", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .browser.clickMatch("1", "tr [data-id='7']")
      .catch(() => {
        /* never answered */
      });

    expect(fake.calls).toStrictEqual([
      ["clickBrowserWindowMatch", "1", "tr [data-id='7']"],
    ]);
  });

  it("fetches with the browser's cookies", () => {
    const fake = new FakeDomicileHost();
    const { browser } = desktop(fake.host);
    browser.fetch("https://mail.example/feed").catch(() => {
      /* never answered */
    });
    browser
      .fetch("https://mail.example/api", {
        body: "{}",
        headers: [{ name: "Content-Type", value: "application/json" }],
        method: "POST",
        profile: "work",
        sapisidHashOrigin: "https://mail.example",
      })
      .catch(() => {
        /* never answered */
      });

    expect(fake.calls).toStrictEqual([
      [
        "fetchWithCookies",
        "https://mail.example/feed",
        "GET",
        [],
        null,
        null,
        "",
      ],
      [
        "fetchWithCookies",
        "https://mail.example/api",
        "POST",
        [{ name: "Content-Type", value: "application/json" }],
        "{}",
        "https://mail.example",
        "work",
      ],
    ]);
  });

  it("says the windows changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).browser.on("change", () => {
        resolve(undefined);
      });
    });
    fake.openBrowser("https://example.com/");

    expect(await changed).toBeUndefined();
  });
});
