import { afterAll, describe, expect, it } from "bun:test";

import { createWebSocket } from "./web-socket";

/** Echoes each message, and first says the handshake's headers. */
const server = Bun.serve<{
  cookie: string | null;
  origin: string | null;
  team: string | null;
}>({
  fetch: (request, bun) =>
    bun.upgrade(request, {
      data: {
        cookie: request.headers.get("cookie"),
        origin: request.headers.get("origin"),
        team: request.headers.get("x-team"),
      },
      headers:
        request.headers.get("sec-websocket-protocol") === null
          ? {}
          : { "sec-websocket-protocol": "chat" },
    })
      ? undefined
      : new Response("not a websocket", { status: 400 }),
  port: 0,
  websocket: {
    message: (socket, message) => {
      socket.send(message);
    },
    open: (socket) => {
      socket.send(JSON.stringify(socket.data));
    },
  },
});
afterAll(() => server.stop());

const URL_ = `ws://127.0.0.1:${server.port}/live`;

type CookieFilter = { url?: string };

const sessions = () => {
  const asked: { partition: string; filter: CookieFilter }[] = [];
  const sessionOf = (partition: string) => ({
    cookies: {
      get: (filter: CookieFilter) => {
        asked.push({ filter, partition });
        return Promise.resolve([
          { name: "d", value: partition === "" ? "own" : partition },
        ]);
      },
    },
  });
  const made = new Map<string, ReturnType<typeof sessionOf>>();
  const fromPartition = (partition: string) => {
    const found = made.get(partition) ?? sessionOf(partition);
    made.set(partition, found);
    return found;
  };
  return {
    asked,
    sessions: { defaultSession: fromPartition(""), fromPartition },
  };
};

const firstMessage = (socket: EventTarget) =>
  new Promise<unknown>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve((event as MessageEvent).data),
      { once: true },
    );
  });

describe(createWebSocket, () => {
  it("opens with the URL's own origin and no cookies, and hands binary messages over as Buffers", async () => {
    const WebSocket = createWebSocket(sessions().sessions);
    const socket = new WebSocket(URL_);
    const opened = new Promise((resolve) => {
      socket.onopen = resolve;
    });

    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    expect(JSON.parse(String(await firstMessage(socket)))).toEqual({
      cookie: null,
      origin: `http://127.0.0.1:${server.port}`,
      team: null,
    });
    await opened;
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(socket.binaryType).toBe("nodebuffer");
    socket.send(new Uint8Array([1, 2, 3]));
    const echoed = await firstMessage(socket);
    expect(Buffer.isBuffer(echoed)).toBe(true);
    expect([...(echoed as Buffer)]).toEqual([1, 2, 3]);
    const closed = new Promise((resolve) => {
      socket.addEventListener("close", resolve);
    });
    socket.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("sends its session's cookies, its headers and origin, and its protocols when asked", async () => {
    const { asked, sessions: made } = sessions();
    const WebSocket = createWebSocket(made);
    const socket = new WebSocket(URL_, {
      headers: { "x-team": "core" },
      origin: "https://app.test",
      partition: "persist:work",
      protocols: ["chat"],
      useSessionCookies: true,
    });

    expect(JSON.parse(String(await firstMessage(socket)))).toEqual({
      cookie: "d=persist:work",
      origin: "https://app.test",
      team: "core",
    });
    expect(socket.protocol).toBe("chat");
    expect(asked).toEqual([
      {
        filter: { url: `http://127.0.0.1:${server.port}/live` },
        partition: "persist:work",
      },
    ]);
    socket.close();
  });

  it("refuses to send while it connects, as a browser's does", () => {
    const WebSocket = createWebSocket(sessions().sessions);
    const socket = new WebSocket(URL_, { useSessionCookies: true });

    expect(() => socket.send("early")).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    socket.close();
  });

  it("closes before it connects when the app closes it while it gets cookies", async () => {
    const WebSocket = createWebSocket(sessions().sessions);
    const socket = new WebSocket(URL_, { useSessionCookies: true });
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve;
    });

    socket.close(4000, "changed my mind");

    expect((await closed).code).toBe(4000);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
