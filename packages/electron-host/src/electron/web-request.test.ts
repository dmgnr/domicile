import { describe, expect, it } from "bun:test";

import type { IncomingWebRequest, WebRequestMessage } from "./web-request";
import { createWebRequests, matchesUrlPattern } from "./web-request";

const setUp = () => {
  const sent: WebRequestMessage[] = [];
  const webRequests = createWebRequests(
    (message) => sent.push(message),
    (window) => (window === 1 ? { id: 1 } : undefined),
  );
  return { sent, webRequests };
};

const incoming = (
  event: IncomingWebRequest["event"],
  more: Partial<IncomingWebRequest> = {},
): IncomingWebRequest => ({
  event,
  id: 4,
  method: "GET",
  referrer: "",
  resource_type: "mainFrame",
  session: "",
  url: "https://a.test/",
  window: 1,
  ...more,
});

describe(createWebRequests, () => {
  it("tells the engine each session's events as listeners come and go", () => {
    const { sent, webRequests } = setUp();
    const webRequest = webRequests.forSession("persist:a");

    webRequest.onBeforeRequest(() => undefined);
    webRequest.onCompleted({ urls: ["*://*/*"] }, () => undefined);
    webRequest.onBeforeRequest(null);

    expect(sent).toEqual([
      {
        events: ["before_request"],
        session: "persist:a",
        type: "web_request_listen",
      },
      {
        events: ["before_request", "completed"],
        session: "persist:a",
        type: "web_request_listen",
      },
      {
        events: ["completed"],
        session: "persist:a",
        type: "web_request_listen",
      },
    ]);
  });

  it("asks a waiting event's listener and answers with what it says", () => {
    const { sent, webRequests } = setUp();
    const heard: unknown[] = [];
    webRequests.forSession("").onBeforeRequest((details, callback) => {
      heard.push(details);
      callback({ cancel: false, redirectURL: "https://b.test/" });
    });
    sent.length = 0;

    webRequests.hear(incoming("before_request", { ask: 3 }));

    expect(heard).toEqual([
      expect.objectContaining({
        id: 4,
        method: "GET",
        referrer: "",
        resourceType: "mainFrame",
        url: "https://a.test/",
        webContents: { id: 1 },
        webContentsId: 1,
      }),
    ]);
    expect(sent).toEqual([
      {
        ask: 3,
        cancel: false,
        redirect_url: "https://b.test/",
        type: "web_request_answer",
      },
    ]);
  });

  it("hands headers over as Electron's objects and takes them back as pairs", () => {
    const { sent, webRequests } = setUp();
    const webRequest = webRequests.forSession("");
    webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, "User-Agent": "Claude" },
      });
    });
    webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "permissions-policy": "camera=(self)",
        },
        ...(details.statusLine === undefined
          ? {}
          : { statusLine: details.statusLine }),
      });
    });
    sent.length = 0;

    webRequests.hear(
      incoming("before_send_headers", {
        ask: 1,
        request_headers: [["accept", "*/*"]],
      }),
    );
    webRequests.hear(
      incoming("headers_received", {
        ask: 2,
        response_headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
        status_code: 200,
        status_line: "HTTP/1.1 200 OK",
      }),
    );

    expect(sent).toEqual([
      {
        ask: 1,
        request_headers: [
          ["accept", "*/*"],
          ["User-Agent", "Claude"],
        ],
        type: "web_request_answer",
      },
      {
        ask: 2,
        response_headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
          ["permissions-policy", "camera=(self)"],
        ],
        status_line: "HTTP/1.1 200 OK",
        type: "web_request_answer",
      },
    ]);
  });

  it("keeps only what each event may change, as Electron ignores the rest", () => {
    const { sent, webRequests } = setUp();
    webRequests
      .forSession("")
      .onBeforeRequest((_details, callback) =>
        callback({ requestHeaders: { a: "1" } } as never),
      );
    sent.length = 0;

    webRequests.hear(incoming("before_request", { ask: 5 }));

    expect(sent).toEqual([{ ask: 5, type: "web_request_answer" }]);
  });

  it("lets a request through that its listener's filter leaves out", () => {
    const { sent, webRequests } = setUp();
    const heard: string[] = [];
    webRequests
      .forSession("")
      .onBeforeRequest(
        { types: ["xhr"], urls: ["*://*.b.test/*"] },
        (details, callback) => {
          heard.push(details.url);
          callback({ cancel: true });
        },
      );
    sent.length = 0;

    webRequests.hear(incoming("before_request", { ask: 1 }));
    webRequests.hear(
      incoming("before_request", {
        ask: 2,
        resource_type: "xhr",
        url: "https://x.b.test/api",
      }),
    );

    expect(heard).toEqual(["https://x.b.test/api"]);
    expect(sent).toEqual([
      { ask: 1, type: "web_request_answer" },
      { ask: 2, cancel: true, type: "web_request_answer" },
    ]);
  });

  it("tells a listener of an event nothing waits on", () => {
    const { sent, webRequests } = setUp();
    const heard: unknown[] = [];
    webRequests.forSession("").onErrorOccurred((details) => {
      heard.push(details);
    });
    sent.length = 0;

    webRequests.hear(
      incoming("error_occurred", {
        error: "net::ERR_ABORTED",
        from_cache: true,
        ip: "192.0.2.1",
        window: undefined,
      }),
    );

    expect(heard).toEqual([
      expect.objectContaining({
        error: "net::ERR_ABORTED",
        fromCache: true,
        ip: "192.0.2.1",
      }),
    ]);
    expect(heard[0]).not.toHaveProperty("webContentsId");
    expect(sent).toEqual([]);
  });

  it("cancels the request of a listener that throws, and throws on", () => {
    const { sent, webRequests } = setUp();
    webRequests.forSession("").onBeforeRequest(() => {
      throw new Error("listener broke");
    });
    sent.length = 0;

    expect(() =>
      webRequests.hear(incoming("before_request", { ask: 1 })),
    ).toThrow("listener broke");
    expect(sent).toEqual([
      { ask: 1, cancel: true, type: "web_request_answer" },
    ]);
  });

  it("answers an event whose listener went, so the request goes on", () => {
    const { sent, webRequests } = setUp();
    webRequests.forSession("");
    sent.length = 0;

    webRequests.hear(incoming("headers_received", { ask: 9 }));

    expect(sent).toEqual([{ ask: 9, type: "web_request_answer" }]);
  });
});

describe(matchesUrlPattern, () => {
  it("matches Chromium's URL patterns", () => {
    expect(matchesUrlPattern("<all_urls>", "https://a.test/x")).toBe(true);
    expect(matchesUrlPattern("*://*/*", "http://a.test/")).toBe(true);
    expect(matchesUrlPattern("*://*/*", "file:///a")).toBe(false);
    expect(matchesUrlPattern("https://*.a.test/*", "https://a.test/")).toBe(
      true,
    );
    expect(matchesUrlPattern("https://*.a.test/*", "https://b.a.test/x")).toBe(
      true,
    );
    expect(matchesUrlPattern("https://*.a.test/*", "https://ba.test/")).toBe(
      false,
    );
    expect(
      matchesUrlPattern("https://a.test/api/*", "https://a.test/api/x"),
    ).toBe(true);
    expect(matchesUrlPattern("https://a.test/api/*", "https://a.test/b")).toBe(
      false,
    );
    expect(matchesUrlPattern("https://a.test:8080/*", "https://a.test/")).toBe(
      false,
    );
    expect(matchesUrlPattern("https://a.test/*", "https://a.test:8080/")).toBe(
      true,
    );
  });
});
