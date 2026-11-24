import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { encodePng } from "../png";
import type { DevToolsEvents, PageCaller, PageMethod } from "./page-control";
import { createPageControl } from "./page-control";

/** A page that records what it is asked and answers from `answers`. */
const fakePage = (answer: (method: PageMethod) => unknown = () => null) => {
  const called: PageMethod[] = [];
  const afterLoad: PageMethod[] = [];
  const set: PageMethod[] = [];
  const devtools: DevToolsEvents = new EventEmitter();
  const page: PageCaller = {
    call: (method) => {
      called.push(method);
      return Promise.resolve(answer(method));
    },
    callAfterLoad: (method) => {
      afterLoad.push(method);
      return Promise.resolve(answer(method));
    },
    devtools,
    isShowing: () => true,
    set: (method) => {
      set.push(method);
    },
  };
  return { afterLoad, called, control: createPageControl(page), devtools, set };
};

const PNG_2X1 = Buffer.from(
  encodePng({
    height: 1,
    rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    width: 2,
  }),
);

describe(createPageControl, () => {
  describe("style sheets", () => {
    it("inserts CSS after any load, as the author's unless the app says the user's, and removes it as it went in", async () => {
      const { afterLoad, called, control } = fakePage((method) =>
        method.method === "insert_css" ? `key-${method.css}` : null,
      );

      const author = await control.insertCSS("a{}");
      const user = await control.insertCSS("b{}", { cssOrigin: "user" });
      await control.removeInsertedCSS(user);
      await control.removeInsertedCSS(author);

      expect(afterLoad).toEqual([
        { css: "a{}", method: "insert_css", user: false },
        { css: "b{}", method: "insert_css", user: true },
      ]);
      expect(called).toEqual([
        { key: "key-b{}", method: "remove_inserted_css", user: true },
        { key: "key-a{}", method: "remove_inserted_css", user: false },
      ]);
    });
  });

  it("runs scripts in an isolated world once the page has loaded", async () => {
    const { afterLoad, control } = fakePage(() => 3);

    const result = await control.executeJavaScriptInIsolatedWorld(
      7,
      [{ code: "1+2" }, { code: "x", url: "app://a/x.js" }],
      true,
    );

    expect(result).toBe(3);
    expect(afterLoad).toEqual([
      {
        method: "execute_in_isolated_world",
        scripts: [{ code: "1+2" }, { code: "x", url: "app://a/x.js" }],
        user_gesture: true,
        world: 7,
      },
    ]);
  });

  describe("capturePage", () => {
    it("captures the page, or a part of it as it shows, scrolled, as a PNG", async () => {
      const { called, control } = fakePage((method) =>
        method.method === "devtools" &&
        method.devtools_method === "Page.getLayoutMetrics"
          ? { cssVisualViewport: { pageX: 30, pageY: 800 } }
          : { data: PNG_2X1.toString("base64") },
      );

      const whole = await control.capturePage();
      await control.capturePage({ height: 0, width: 0, x: 0, y: 0 });
      await control.capturePage({ height: 20, width: 10, x: 1, y: 2 });

      expect(whole.getSize()).toEqual({ height: 1, width: 2 });
      expect(called).toEqual([
        {
          devtools_method: "Page.captureScreenshot",
          method: "devtools",
          params: { format: "png", fromSurface: true },
        },
        {
          devtools_method: "Page.captureScreenshot",
          method: "devtools",
          params: { format: "png", fromSurface: true },
        },
        {
          devtools_method: "Page.getLayoutMetrics",
          method: "devtools",
          params: {},
        },
        {
          devtools_method: "Page.captureScreenshot",
          method: "devtools",
          params: {
            clip: { height: 20, scale: 1, width: 10, x: 31, y: 802 },
            format: "png",
            fromSurface: true,
          },
        },
      ]);
    });
  });

  describe("printToPDF", () => {
    it("prints Letter with Electron's margins by default", async () => {
      const { called, control } = fakePage(() => ({
        data: Buffer.from("%PDF").toString("base64"),
      }));

      const pdf = await control.printToPDF({});

      expect(pdf.toString()).toBe("%PDF");
      expect(called).toEqual([
        {
          devtools_method: "Page.printToPDF",
          method: "devtools",
          params: {
            displayHeaderFooter: false,
            footerTemplate: "",
            generateDocumentOutline: false,
            generateTaggedPDF: false,
            headerTemplate: "",
            landscape: false,
            marginBottom: 0.4,
            marginLeft: 0.4,
            marginRight: 0.4,
            marginTop: 0.4,
            pageRanges: "",
            paperHeight: 11,
            paperWidth: 8.5,
            preferCSSPageSize: false,
            printBackground: false,
            scale: 1,
            transferMode: "ReturnAsBase64",
          },
        },
      ]);
    });

    it("takes the app's page size, by name or in inches, and its options", async () => {
      const { called, control } = fakePage(() => ({ data: "" }));

      await control.printToPDF({
        displayHeaderFooter: true,
        landscape: true,
        margins: { left: 1, top: 0 },
        pageRanges: "1-2",
        pageSize: "A4",
        printBackground: true,
        scale: 1.5,
      });
      await control.printToPDF({ pageSize: { height: 5, width: 4 } });

      expect(
        called.map((method) => "params" in method && method.params),
      ).toEqual([
        expect.objectContaining({
          displayHeaderFooter: true,
          landscape: true,
          marginBottom: 0.4,
          marginLeft: 1,
          marginRight: 0.4,
          marginTop: 0,
          pageRanges: "1-2",
          paperHeight: 11.7,
          paperWidth: 8.27,
          printBackground: true,
          scale: 1.5,
        }),
        expect.objectContaining({ paperHeight: 5, paperWidth: 4 }),
      ]);
    });

    it("rejects a page size or scale Electron refuses", async () => {
      const { called, control } = fakePage();

      await expect(control.printToPDF({ pageSize: "B9" })).rejects.toThrow(
        "Invalid pageSize B9",
      );
      await expect(control.printToPDF({ scale: 3 })).rejects.toThrow(
        "scale must be between 0.1 and 2",
      );
      expect(called).toEqual([]);
    });
  });

  it("copies the image or the video frame at a point, and adjusts the selection", () => {
    const { called, control } = fakePage();

    control.copyImageAt(1, 2);
    // The engine takes whole pixels.
    control.copyVideoFrameAt(3.4, 3.6);
    control.adjustSelection({ end: -1, start: 2 });
    control.adjustSelection({});
    control.reloadIgnoringCache();

    expect(called).toEqual([
      { method: "copy_image_at", x: 1, y: 2 },
      { method: "copy_video_frame_at", x: 3, y: 4 },
      { end: -1, method: "adjust_selection", start: 2 },
      { end: 0, method: "adjust_selection", start: 0 },
      { method: "reload_ignoring_cache" },
    ]);
  });

  describe("settings", () => {
    it("sets caret browsing and the WebRTC IP policy, and reads them back", () => {
      const { control, set } = fakePage();

      expect(control.isCaretBrowsingEnabled()).toBe(false);
      expect(control.getWebRTCIPHandlingPolicy()).toBe("default");
      control.setCaretBrowsingEnabled(true);
      control.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");

      expect(control.isCaretBrowsingEnabled()).toBe(true);
      expect(control.getWebRTCIPHandlingPolicy()).toBe(
        "disable_non_proxied_udp",
      );
      expect(set).toEqual([
        { enabled: true, method: "set_caret_browsing" },
        { method: "set_webrtc_ip_policy", policy: "disable_non_proxied_udp" },
      ]);
    });

    it("refuses a WebRTC IP policy Electron doesn't know", () => {
      const { control, set } = fakePage();

      expect(() => control.setWebRTCIPHandlingPolicy("all")).toThrow(
        "Invalid WebRTC IP handling policy: all",
      );
      expect(set).toEqual([]);
    });

    it("emulates a device until told to stop", () => {
      const { control, set } = fakePage();

      control.enableDeviceEmulation({
        deviceScaleFactor: 2,
        scale: 1,
        screenPosition: "mobile",
        screenSize: { height: 800, width: 400 },
        viewPosition: { x: 0, y: 10 },
        viewSize: { height: 700, width: 380 },
      });
      control.disableDeviceEmulation();

      expect(set).toEqual([
        {
          devtools_method: "Emulation.setDeviceMetricsOverride",
          method: "devtools",
          params: {
            deviceScaleFactor: 2,
            height: 700,
            mobile: true,
            positionX: 0,
            positionY: 10,
            scale: 1,
            screenHeight: 800,
            screenWidth: 400,
            width: 380,
          },
        },
        {
          devtools_method: "Emulation.clearDeviceMetricsOverride",
          method: "devtools",
          params: {},
        },
      ]);
    });
  });

  describe("frame subscription", () => {
    it("hands each frame to the subscriber, acknowledged, until it ends", () => {
      const { called, control, devtools, set } = fakePage();
      const frames: [{ width: number; height: number }, unknown][] = [];

      control.beginFrameSubscription((image, dirty) => {
        frames.push([image.getSize(), dirty]);
      });
      devtools.emit("Page.screencastFrame", {
        data: PNG_2X1.toString("base64"),
        sessionId: 4,
      });
      control.endFrameSubscription();
      devtools.emit("Page.screencastFrame", {
        data: PNG_2X1.toString("base64"),
        sessionId: 5,
      });

      expect(frames).toEqual([
        [
          { height: 1, width: 2 },
          { height: 1, width: 2, x: 0, y: 0 },
        ],
      ]);
      expect(set).toEqual([
        {
          devtools_method: "Page.startScreencast",
          method: "devtools",
          params: { format: "png" },
        },
        {
          devtools_method: "Page.stopScreencast",
          method: "devtools",
          params: {},
        },
      ]);
      expect(called).toEqual([
        {
          devtools_method: "Page.screencastFrameAck",
          method: "devtools",
          params: { sessionId: 4 },
        },
      ]);
    });

    it("takes the callback after onlyDirty, and a second subscription replaces the first", () => {
      const { control, devtools, set } = fakePage();
      const heard: string[] = [];

      control.beginFrameSubscription(() => heard.push("first"));
      control.beginFrameSubscription(true, () => heard.push("second"));
      devtools.emit("Page.screencastFrame", {
        data: PNG_2X1.toString("base64"),
        sessionId: 1,
      });

      expect(heard).toEqual(["second"]);
      expect(set).toHaveLength(1);
    });
  });
});
