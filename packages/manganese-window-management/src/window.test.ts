import { describe, expect, it } from "bun:test";

import {
  appIdOf,
  appWindowId,
  browserIdOf,
  browserWindowId,
  ShellWindow,
  siteOf,
  WindowKind,
} from "./window";

describe("ShellWindow", () => {
  describe("App", () => {
    it("namespaces the app id so a client cannot collide with a browser", () => {
      expect(ShellWindow.App("term", "Terminal")).toStrictEqual({
        appId: "term",
        // Unset until the client reports them.
        cursor: undefined,
        cursorImage: undefined,
        desktopId: "",
        id: "app:term",
        kind: WindowKind.App,
        maxSize: [undefined, undefined],
        minSize: [undefined, undefined],
        syncedFrame: 0,
        title: "Terminal",
      });
    });
  });

  describe("appIdOf", () => {
    it("reads the client back out of a window id", () => {
      expect(appIdOf(ShellWindow.App("term", "Terminal").id)).toBe("term");
    });

    it("has no client for a browser window", () => {
      expect(
        appIdOf(
          ShellWindow.Browser(
            "1",
            "https://example.com",
            "",
            undefined,
            false,
            false,
          ).id,
        ),
      ).toBe(undefined);
    });
  });

  describe("browserIdOf", () => {
    it("reads the engine's window back out of a window id", () => {
      expect(browserIdOf(browserWindowId("4"))).toBe("4");
    });

    it("has no engine window for a client's", () => {
      expect(browserIdOf(appWindowId("term"))).toBe(undefined);
    });
  });

  describe("Browser", () => {
    it("titles the window with its page's title", () => {
      expect(
        ShellWindow.Browser(
          "2",
          "https://www.google.com/search",
          "Google Search",
          undefined,
          false,
          false,
        ),
      ).toMatchObject({ title: "Google Search" });
    });

    it("titles the window with the site a page with no title is at", () => {
      expect(
        ShellWindow.Browser(
          "2",
          "https://www.google.com/search",
          "",
          undefined,
          true,
          false,
        ),
      ).toEqual({
        appId: "",
        // The view reports these later.
        description: undefined,
        icon: undefined,
        id: browserWindowId("2"),
        isApp: false,
        isHidden: false,
        isPrivate: true,
        kind: WindowKind.Browser,
        popupWindow: undefined,
        title: "www.google.com",
        url: "https://www.google.com/search",
      });
    });

    it("titles a window that has shown nothing yet as a blank page", () => {
      // The engine lists a window before its page has an address. An empty
      // name would leave an unlabeled tab.
      expect(
        ShellWindow.Browser("2", "", "", undefined, false, false),
      ).toMatchObject({
        title: "about:blank",
      });
    });
  });
});

describe("siteOf", () => {
  it("names a window after the site it is showing", () => {
    expect(siteOf("https://docs.example.com/guide")).toBe("docs.example.com");
  });

  // A page can navigate to `about:blank` or a `data:` URL, which have no host.
  it("falls back to the whole address when there is no host to name", () => {
    expect(siteOf("about:blank")).toBe("about:blank");
    expect(siteOf("data:text/html,hi")).toBe("data:text/html,hi");
  });
});
