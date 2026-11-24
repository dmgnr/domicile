import { afterAll, describe, expect, it } from "bun:test";

import { createNet } from "./net";

const net = createNet(globalThis.WebSocket);

const server = Bun.serve({
  fetch: async (request) =>
    new URL(request.url).pathname === "/slow"
      ? new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode("first"));
            },
          }),
        )
      : new Response(
          `${request.method} ${new URL(request.url).pathname} ${await request.text()} ${request.headers.get("x-app")}`,
          {
            headers: { "x-answer": "yes" },
            status: 201,
          },
        ),
  port: 0,
});
afterAll(() => server.stop());

/** Answers 401 with a Basic challenge until it is given me:secret. */
const guarded = Bun.serve({
  fetch: (request) =>
    request.headers.get("authorization") ===
    `Basic ${Buffer.from("me:secret").toString("base64")}`
      ? new Response("in")
      : new Response("out", {
          headers: { "www-authenticate": 'Basic realm="office"' },
          status: 401,
        }),
  port: 0,
});
afterAll(() => guarded.stop());

const statusOf = (request: ReturnType<typeof net.request>) =>
  new Promise<number>((resolve) => {
    request.on("response", (response) => resolve(response.statusCode));
  });

describe("net.request", () => {
  it("sends what was written and gives the response as Electron's", async () => {
    const request = net.request({
      method: "POST",
      url: `http://localhost:${server.port}/upload`,
    });
    request.setHeader("x-app", "slack");
    const answer = new Promise<{
      status: number;
      header: unknown;
      body: string;
    }>((resolve) => {
      request.on("response", (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () =>
          resolve({
            body,
            header: response.headers["x-answer"],
            status: response.statusCode,
          }),
        );
      });
    });
    request.write("hello ");
    request.end("world");

    expect(await answer).toEqual({
      body: "POST /upload hello world slack",
      header: "yes",
      status: 201,
    });
  });

  it("reaches the host and port it is given, a host's own port first, as Electron does", async () => {
    const bodyOf = (options: Parameters<typeof net.request>[0]) =>
      new Promise<string>((resolve) => {
        const request = net.request(options);
        request.on("response", (response) => {
          let body = "";
          response.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on("end", () => resolve(body));
        });
        request.end();
      });

    expect(
      await bodyOf({
        hostname: "localhost",
        path: "/a",
        port: Number(server.port),
      }),
    ).toStartWith("GET /a");
    expect(
      await bodyOf({
        host: `localhost:${server.port}`,
        hostname: "localhost",
        path: "/b",
      }),
    ).toStartWith("GET /b");
  });

  it("says its response was aborted when the request is aborted mid-body", async () => {
    const request = net.request(`http://localhost:${server.port}/slow`);
    const heard: string[] = [];
    const closed = new Promise<void>((resolve) => {
      request.on("response", (response) => {
        response.once("data", () => request.abort());
        response.on("aborted", () => heard.push("aborted"));
      });
      request.on("abort", () => heard.push("abort"));
      request.on("close", () => resolve());
    });
    request.end();
    await closed;

    expect(heard).toEqual(["aborted", "abort"]);
  });

  it("emits error when the request can't be made", async () => {
    const request = net.request("http://localhost:1/nothing");
    const failed = new Promise((resolve) => request.on("error", resolve));
    request.end();
    expect(await failed).toBeInstanceOf(Error);
  });
});

describe("ClientRequest's login", () => {
  it("asks for a sign-in and sends again with what the callback gives", async () => {
    const request = net.request(`http://localhost:${guarded.port}/`);
    const asked = new Promise((resolve) => {
      request.on("login", (authInfo, callback) => {
        resolve(authInfo);
        callback("me", "secret");
      });
    });
    const status = statusOf(request);
    request.end();

    expect(await asked).toEqual({
      host: "localhost",
      isProxy: false,
      port: guarded.port,
      realm: "office",
      scheme: "basic",
    });
    expect(await status).toBe(200);
  });

  it("gives the 401 when the callback gives nothing, or nothing listens", async () => {
    const canceled = net.request(`http://localhost:${guarded.port}/`);
    canceled.on("login", (_authInfo, callback) => callback());
    const unheard = net.request(`http://localhost:${guarded.port}/`);
    const statuses = Promise.all([statusOf(canceled), statusOf(unheard)]);
    canceled.end();
    unheard.end();

    expect(await statuses).toEqual([401, 401]);
  });
});
