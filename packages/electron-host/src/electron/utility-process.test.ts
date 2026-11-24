import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessagePortMain } from "./message-port-main";
import { MessageChannelMain } from "./message-port-main";
import type { UtilityProcess } from "./utility-process";
import { createUtilityProcess } from "./utility-process";

/** What `app`'s `child-process-gone` would say, in order. */
const gone: unknown[] = [];
const utilityProcess = createUtilityProcess((details) => gone.push(details));

const directory = await mkdtemp(join(tmpdir(), "electron-host-utility-"));
afterAll(() => rm(directory, { force: true, recursive: true }));

/** Writes a utility process's module, as an app ships one. */
const worker = async (name: string, source: string) => {
  const path = join(directory, name);
  await writeFile(path, source);
  return path;
};

/** Resolves with the first `event` `child` emits, with its arguments. */
const next = <T extends unknown[]>(child: UtilityProcess, event: string) =>
  new Promise<T>((resolve) => {
    child.once(event, (...args: unknown[]) => resolve(args as T));
  });

const nextMessage = (port: MessagePortMain) =>
  new Promise<unknown>((resolve) => {
    port.once("message", (event: { data: unknown }) => resolve(event.data));
  });

describe("utilityProcess.fork", () => {
  it("runs the module as a utility process, with its arguments and parentPort", async () => {
    const child = utilityProcess.fork(
      await worker(
        "says.js",
        `process.parentPort.postMessage({
          argv: process.argv.slice(2),
          type: process.type,
        });`,
      ),
      ["--flag", "value"],
    );
    const [spawned, [message]] = await Promise.all([
      next(child, "spawn"),
      next<[unknown]>(child, "message"),
    ]);

    expect(spawned).toEqual([]);
    expect(child.pid).toBeGreaterThan(0);
    expect(message).toEqual({ argv: ["--flag", "value"], type: "utility" });
    child.kill();
  });

  it("hands a port to the module with a message, and carries what goes over it as it is", async () => {
    const child = utilityProcess.fork(
      await worker(
        "echo.js",
        `process.parentPort.once("message", (event) => {
          const [port] = event.ports;
          port.on("message", (message) => {
            port.postMessage({ echo: message.data, init: event.data });
          });
          port.start();
        });`,
      ),
    );
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: "init" }, [port2]);
    port1.start();
    const reply = nextMessage(port1);

    port1.postMessage(new Uint8Array([1, 2]));

    expect(await reply).toEqual({
      echo: new Uint8Array([1, 2]),
      init: { type: "init" },
    });
    child.kill();
  });

  it("closes the module's ports and says how it exited when it goes", async () => {
    const child = utilityProcess.fork(
      await worker(
        "exits.js",
        `process.parentPort.once("message", () => process.exit(7));`,
      ),
    );
    const { port1, port2 } = new MessageChannelMain();
    const closed = new Promise<void>((resolve) => {
      port1.once("close", () => resolve());
    });
    const exited = next<[number]>(child, "exit");

    child.postMessage("bye", [port2]);

    expect(await exited).toEqual([7]);
    await closed;
  });

  it("tells the app of a module that went with an error or was killed, not one that finished", async () => {
    gone.length = 0;
    const failed = utilityProcess.fork(
      await worker("fails.js", `process.exit(7);`),
      [],
      { serviceName: "Indexer" },
    );
    await next(failed, "exit");
    const finished = utilityProcess.fork(
      await worker("ends.js", `process.exit(0);`),
    );
    await next(finished, "exit");
    const killed = utilityProcess.fork(
      await worker("lingers.js", `setInterval(() => undefined, 1000);`),
    );
    await next(killed, "spawn");
    killed.kill();
    await next(killed, "exit");

    expect(gone).toEqual([
      {
        exitCode: 7,
        name: "Indexer",
        reason: "abnormal-exit",
        serviceName: "Indexer",
        type: "Utility",
      },
      {
        exitCode: 143,
        name: "Node Utility Process",
        reason: "killed",
        serviceName: "Node Utility Process",
        type: "Utility",
      },
    ]);
  });

  it("pipes the module's output when asked", async () => {
    const child = utilityProcess.fork(
      await worker("prints.js", `console.log("from the worker");`),
      [],
      { stdio: "pipe" },
    );
    const out = await new Promise<string>((resolve) => {
      child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    child.kill();

    expect(out).toBe("from the worker\n");
  });

  it("passes the environment it is given, and only that", async () => {
    const child = utilityProcess.fork(
      await worker(
        "env.js",
        `process.parentPort.postMessage([process.env.GIVEN, process.env.HOME]);`,
      ),
      [],
      { env: { GIVEN: "yes" } },
    );
    const [message] = await next<[unknown]>(child, "message");

    expect(message).toEqual(["yes", undefined]);
    child.kill();
  });

  it("says a killed module exited, with no pid after", async () => {
    const child = utilityProcess.fork(
      await worker("waits.js", `setInterval(() => undefined, 1000);`),
    );
    await next(child, "spawn");
    const exited = next<[number]>(child, "exit");

    expect(child.kill()).toBe(true);
    // A shell's code for SIGTERM: never 0, so a killed child never reads as
    // one that finished.
    expect(await exited).toEqual([143]);
    expect(child.pid).toBeUndefined();
  });
});
