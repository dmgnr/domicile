import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import type { Result } from "@cprussin/option-result";

import type { IpcSender } from "./ipc-main";
import { createIpcMain } from "./ipc-main";
import { MessageChannelMain } from "./message-port-main";

const page = () => {
  const sent: [string, unknown[]][] = [];
  const sender: IpcSender = {
    id: 3,
    send: (channel, ...args) => sent.push([channel, args]),
  };
  return { sender, sent };
};

type Outcome = { readonly error: string } | { readonly value: unknown };

/** A result as plain data, to compare. */
const outcome = (
  answer: Result<{ readonly result: unknown }, string>,
): Outcome =>
  answer.match<Outcome>({
    Err: (error) => ({ error }),
    Ok: ({ result }) => ({ value: result }),
  });

describe(createIpcMain, () => {
  it("names the page's main frame as the sender's frame, as Slack checks", async () => {
    const { invoke, ipcMain, receive } = createIpcMain();
    const frame = { processId: 5, routingId: 7 };
    const sender: IpcSender = {
      id: 3,
      mainFrame: frame,
      send: () => undefined,
    };
    const heard: unknown[] = [];
    ipcMain.on(
      "state",
      (event: { frameId: number; processId: number; senderFrame: unknown }) =>
        heard.push(event.senderFrame, event.processId, event.frameId),
    );
    ipcMain.handle(
      "get",
      (event) => (event as { senderFrame: unknown }).senderFrame === frame,
    );

    receive(sender, "state", []);

    expect(heard).toEqual([frame, 5, 7]);
    expect(outcome(await invoke(sender, "get", []))).toEqual({ value: true });
  });

  it("gives a page's send to the channel's listeners, with its page", () => {
    const { ipcMain, receive } = createIpcMain();
    const { sender } = page();
    const heard: unknown[] = [];
    ipcMain.on("save", (event: { sender: IpcSender }, ...args: unknown[]) =>
      heard.push(event.sender.id, ...args),
    );

    receive(sender, "save", [1, "a"]);

    expect(heard).toEqual([3, 1, "a"]);
  });

  it("replies on the page's ipcRenderer", () => {
    const { ipcMain, receive } = createIpcMain();
    const { sender, sent } = page();
    ipcMain.on("ping", (event: { reply: (c: string, v: unknown) => void }) =>
      event.reply("pong", 1),
    );

    receive(sender, "ping", []);

    expect(sent).toEqual([["pong", [1]]]);
  });

  it("answers an invoke with its handler's result, awaited", async () => {
    const { invoke, ipcMain } = createIpcMain();
    ipcMain.handle("double", (_event, n) => Promise.resolve(Number(n) * 2));

    const answer = await invoke(page().sender, "double", [2]);

    expect(outcome(answer)).toEqual({ value: 4 });
  });

  it("fails an invoke whose handler throws, with what it threw", async () => {
    const { invoke, ipcMain } = createIpcMain();
    ipcMain.handle("fail", () => {
      throw new Error("no");
    });

    const answer = await invoke(page().sender, "fail", []);

    expect(outcome(answer)).toEqual({ error: "Error: no" });
  });

  it("fails an invoke nobody handles, in Electron's words", async () => {
    const { invoke } = createIpcMain();

    const answer = await invoke(page().sender, "missing", []);

    expect(outcome(answer)).toEqual({
      error: "No handler registered for 'missing'",
    });
  });

  it("takes one handler a channel, and handleOnce answers once", async () => {
    const { invoke, ipcMain } = createIpcMain();
    ipcMain.handleOnce("once", () => "first");

    expect(() => ipcMain.handle("once", () => "second")).toThrow(
      "Attempted to register a second handler for 'once'",
    );
    expect(outcome(await invoke(page().sender, "once", []))).toEqual({
      value: "first",
    });
    expect((await invoke(page().sender, "once", [])).isErr()).toBe(true);
  });

  describe("sendSync", () => {
    it("answers with the returnValue a listener sets, even later", async () => {
      const { ipcMain, sendSync } = createIpcMain();
      ipcMain.on("now", (event: { returnValue: unknown }, n: number) =>
        queueMicrotask(() => {
          event.returnValue = n * 3;
        }),
      );

      const answer = await sendSync(page().sender, "now", [3]);

      expect(outcome(answer)).toEqual({ value: 9 });
    });

    it("fails one nobody listens for, as nothing could answer it", async () => {
      const { sendSync } = createIpcMain();

      const answer = await sendSync(page().sender, "missing", []);

      expect(outcome(answer)).toEqual({
        error: "Nothing listens for 'missing' to set its returnValue",
      });
    });
  });

  it("gives a page's postMessage to the listeners, with its ports", () => {
    const { ipcMain, post } = createIpcMain();
    const { port1 } = new MessageChannelMain();
    const heard: unknown[] = [];
    ipcMain.on(
      "port",
      (event: { ports: unknown[]; sender: IpcSender }, message: unknown) =>
        heard.push(event.sender.id, event.ports, message),
    );

    post(page().sender, "port", "hi", [port1]);

    expect(heard).toEqual([3, [port1], "hi"]);
  });
});

describe("the page's webContents", () => {
  /** A page that writes down what it emits, as its `webContents` would. */
  const emitting = (heard: unknown[]) => {
    const own = new EventEmitter();
    for (const name of ["ipc-message", "ipc-message-sync"]) {
      own.on(name, (event: unknown, channel: string, ...args: unknown[]) =>
        heard.push([name, channel, ...args], event),
      );
    }
    return {
      emit: own.emit.bind(own),
      id: 1,
      listenerCount: own.listenerCount.bind(own),
      send: () => undefined,
    } satisfies IpcSender;
  };

  it("says each message first, with the event ipcMain gets", () => {
    const routes = createIpcMain();
    const heard: unknown[] = [];
    const sender = emitting(heard);
    routes.ipcMain.on("hi", (event, word) => heard.push(["main", word], event));

    routes.receive(sender, "hi", ["a"]);

    expect(heard.filter((entry) => Array.isArray(entry))).toEqual([
      ["ipc-message", "hi", "a"],
      ["main", "a"],
    ]);
    expect(heard[1]).toBe(heard[3]);
  });

  it("says each sendSync, and is answered by a returnValue set there", async () => {
    const routes = createIpcMain();
    const heard: unknown[] = [];
    const sender = emitting(heard);
    const own = new EventEmitter();
    own.on("ipc-message-sync", (event: { returnValue: unknown }) => {
      event.returnValue = "from the page";
    });

    const answer = await routes.sendSync(
      {
        emit: own.emit.bind(own),
        id: 2,
        listenerCount: own.listenerCount.bind(own),
        send: () => undefined,
      },
      "now",
      [],
    );
    routes.ipcMain.on("now", (event: { returnValue: unknown }) => {
      event.returnValue = "from ipcMain";
    });
    await routes.sendSync(sender, "now", [3]);

    expect(outcome(answer)).toEqual({ value: "from the page" });
    expect(heard[0]).toEqual(["ipc-message-sync", "now", 3]);
  });
});

describe("a page's own webContents.ipc", () => {
  it("hears only its page, and answers that page's invokes ahead of ipcMain", async () => {
    const { IpcMain } = await import("./ipc-main");
    const routes = createIpcMain();
    const own = new IpcMain();
    const page = { id: 1, ipc: own, send: () => undefined };
    const other = { id: 2, send: () => undefined };
    const heard: string[] = [];
    own.on("hi", (_event, word) => heard.push(`own ${word}`));
    routes.ipcMain.on("hi", (event, word) =>
      heard.push(`main ${event.sender.id} ${word}`),
    );
    own.handle("who", () => "own");
    routes.ipcMain.handle("who", () => "main");

    routes.receive(page, "hi", ["a"]);
    routes.receive(other, "hi", ["b"]);

    expect(heard).toEqual(["own a", "main 1 a", "main 2 b"]);
    expect(
      (await routes.invoke(page, "who", [])).unwrapOr({ result: "none" }),
    ).toEqual({ result: "own" });
    expect(
      (await routes.invoke(other, "who", [])).unwrapOr({ result: "none" }),
    ).toEqual({ result: "main" });
  });
});
