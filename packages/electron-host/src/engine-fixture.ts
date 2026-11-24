// A stand-in engine for tests: a Unix socket that writes down each request
// line and answers as a test says.

import { mkdtemp } from "node:fs/promises";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The engine's `ready`, as a fake engine answers hello. */
export const READY = {
  chrome_version: "160.0.8155.0",
  schemes: [],
  type: "ready",
  user_agent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/160.0.0.0 Safari/537.36",
};

export type FakeEngine = {
  readonly path: string;
  /** Every request line, parsed. */
  readonly heard: unknown[];
  /** Sends `event` to the connected app. */
  readonly say: (event: unknown) => void;
  /** Ends the app's connection. */
  readonly drop: () => void;
  /** Resolves once `count` requests have arrived. */
  readonly heardAtLeast: (count: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * The fake engine's answers by default: `hello` gets `ready`, a session's
 * storage path is under /fake-storage, and nothing else gets anything.
 */
export const answerAsDefault = (request: {
  type: string;
  call?: unknown;
  method?: unknown;
  session?: unknown;
}): unknown[] => {
  if (request.type === "hello") {
    return [READY];
  } else if (
    request.type === "session_call" &&
    request.method === "storage_path"
  ) {
    return [
      {
        call: request.call,
        result: `/fake-storage/${String(request.session)}`,
        type: "session_result",
      },
    ];
  } else {
    return [];
  }
};

/** Listens on a fresh socket. `answer` gives the events a request gets back. */
export const startFakeEngine = async (
  answer: (request: { type: string }) => unknown[] = answerAsDefault,
): Promise<FakeEngine> => {
  const dir = await mkdtemp(join(tmpdir(), "electron-host-engine-"));
  const path = join(dir, "electron.sock");
  const heard: unknown[] = [];
  const waiting: { count: number; done: () => void }[] = [];
  let connection: Socket | undefined;

  const say = (event: unknown) => {
    connection?.write(`${JSON.stringify(event)}\n`);
  };

  const server = createServer((socket) => {
    connection = socket;
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const request = JSON.parse(line);
        heard.push(request);
        for (const event of answer(request)) {
          say(event);
        }
        for (const wait of waiting.filter((w) => heard.length >= w.count)) {
          wait.done();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));

  return {
    close: () =>
      new Promise((resolve) => {
        connection?.destroy();
        server.close(() => resolve());
      }),
    drop: () => connection?.end(),
    heard,
    heardAtLeast: (count) =>
      heard.length >= count
        ? Promise.resolve()
        : new Promise((done) => waiting.push({ count, done })),
    path,
    say,
  };
};
