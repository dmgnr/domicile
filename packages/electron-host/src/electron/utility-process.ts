// The stand-in for Electron's `utilityProcess`: a child process of the same
// runtime, running `utility-process-child.ts`, which gives the app's module
// `process.parentPort` and runs it. See "The main process" in
// docs/architecture/ELECTRON-APPS.md.

import type { ChildProcess, StdioOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:os";
import type { Readable } from "node:stream";

import type { ChildProcessGoneDetails } from "./app";
import type { MessagePortMain } from "./message-port-main";
import { createLinkedPorts } from "./message-port-main";

/** What the host and a utility process tell each other over their channel. */
export type UtilityMessage =
  /** A `parentPort` message, with the names of ports sent with it. */
  | {
      readonly kind: "parent";
      readonly data: unknown;
      readonly ports?: readonly string[];
    }
  | { readonly kind: "post"; readonly port: string; readonly data: unknown }
  | { readonly kind: "close"; readonly port: string }
  /** The child listens: a message sent before then would be lost. */
  | { readonly kind: "ready" };

type Stdio = "pipe" | "ignore" | "inherit";

/** The options of Electron's `utilityProcess.fork`, those it heeds. */
export type ForkOptions = {
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  cwd?: string;
  stdio?: Stdio | [Stdio, Stdio, Stdio];
  /** The process's name in `app`'s `child-process-gone`. */
  serviceName?: string;
};

/** Electron's name for a utility process the app names none. */
const DEFAULT_SERVICE_NAME = "Node Utility Process";

/**
 * A child process, with the events this module hears. Under bun-types,
 * `ChildProcess`'s own event methods do not type-check.
 */
type Child = ChildProcess & {
  on(event: "spawn", listener: () => void): Child;
  on(event: "message", listener: (message: UtilityMessage) => void): Child;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): Child;
  on(event: "error", listener: (error: Error) => void): Child;
};

const childModule = new URL("../utility-process-child.ts", import.meta.url)
  .pathname;

/** Electron's `UtilityProcess`: the app's end of one utility process. */
export class UtilityProcess extends EventEmitter {
  readonly #child: Child;
  readonly #ports: ReturnType<typeof createLinkedPorts>;
  #exited = false;
  /** What the app sent before the child listened, in order. */
  #waiting: UtilityMessage[] | undefined = [];

  /** `gone` hears how the process went, when it didn't finish cleanly. */
  constructor(
    modulePath: string,
    args: string[],
    options: ForkOptions,
    gone: (details: ChildProcessGoneDetails) => void,
  ) {
    super();
    let next = 1;
    this.#ports = createLinkedPorts(
      (request) => {
        this.#send(
          request.type === "post"
            ? { data: request.data, kind: "post", port: request.port }
            : { kind: "close", port: request.port },
        );
      },
      () => `p${next++}`,
    );
    this.#child = <Child>(
      spawn(
        process.execPath,
        [...(options.execArgv ?? []), childModule, modulePath, ...args],
        {
          cwd: options.cwd,
          // No env inherits the host's, as Electron's default does.
          env: options.env,
          // Structured clone, as Electron's ports carry.
          serialization: "advanced",
          stdio: stdioOf(options.stdio ?? "inherit"),
        },
      )
    );
    this.#child.on("spawn", () => this.emit("spawn"));
    this.#child.on("message", (message: UtilityMessage) => {
      switch (message.kind) {
        case "parent": {
          this.emit("message", message.data);
          break;
        }
        case "post": {
          this.#ports.message(message.port, message.data);
          break;
        }
        case "close": {
          this.#ports.closed(message.port);
          break;
        }
        case "ready": {
          const waiting = this.#waiting ?? [];
          this.#waiting = undefined;
          for (const queued of waiting) {
            this.#child.send(queued);
          }
          break;
        }
      }
    });
    this.#child.on("exit", (code, signal) => {
      this.#exited = true;
      this.#ports.gone();
      const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);
      if (exitCode !== 0) {
        const name = options.serviceName ?? DEFAULT_SERVICE_NAME;
        gone({
          exitCode,
          name,
          reason: reasonOf(signal),
          serviceName: name,
          type: "Utility",
        });
      }
      this.emit("exit", exitCode);
    });
    this.#child.on("error", (error) => {
      // The runtime itself could not start: nothing the app can answer.
      throw error;
    });
  }

  /** The child's pid, while it runs. */
  get pid() {
    return this.#exited ? undefined : this.#child.pid;
  }

  get stdout(): Readable | null {
    return this.#child.stdout;
  }

  get stderr(): Readable | null {
    return this.#child.stderr;
  }

  /** Sends `message` to the child's `parentPort`, with `transfer`'s ports. */
  readonly postMessage = (
    message: unknown,
    transfer: readonly MessagePortMain[] = [],
  ) => {
    this.#send({
      data: message,
      kind: "parent",
      ports: this.#ports.give(transfer),
    });
  };

  readonly kill = () => this.#child.kill();

  #send(message: UtilityMessage) {
    // After the child goes there is no one to hear, as with a closed port.
    if (this.#exited) {
      return;
    } else if (this.#waiting === undefined) {
      this.#child.send(message);
    } else {
      this.#waiting.push(message);
    }
  }
}

const stdioOf = (stdio: Stdio | [Stdio, Stdio, Stdio]): StdioOptions =>
  typeof stdio === "string"
    ? ["ignore", stdio, stdio, "ipc"]
    : ["ignore", stdio[1], stdio[2], "ipc"];

/** Chromium's reason for a process that went other than cleanly. */
const reasonOf = (
  signal: NodeJS.Signals | null,
): ChildProcessGoneDetails["reason"] => {
  switch (signal) {
    case "SIGINT":
    case "SIGKILL":
    case "SIGTERM":
      return "killed";
    case "SIGABRT":
    case "SIGBUS":
    case "SIGFPE":
    case "SIGILL":
    case "SIGSEGV":
    case "SIGSYS":
    case "SIGTRAP":
      return "crashed";
    default:
      return "abnormal-exit";
  }
};

/**
 * Electron's `utilityProcess`. `gone` hears each process that went other
 * than cleanly, for `app`'s `child-process-gone`.
 */
export const createUtilityProcess = (
  gone: (details: ChildProcessGoneDetails) => void,
) => ({
  fork: (modulePath: string, args: string[] = [], options: ForkOptions = {}) =>
    new UtilityProcess(modulePath, args, options, gone),
});
