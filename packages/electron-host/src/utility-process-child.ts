#!/usr/bin/env bun
// A utility process an app forked: `utility-process-child.ts <module>
// [arguments…]`. Gives the module Electron's `process.parentPort`, over the
// channel to the host, then runs it. See src/electron/utility-process.ts.

import { EventEmitter } from "node:events";

import type { MessagePortMain } from "./electron/message-port-main";
import { createLinkedPorts } from "./electron/message-port-main";
import type { UtilityMessage } from "./electron/utility-process";

const send = (message: UtilityMessage) => {
  process.send?.(message);
};

let next = 1;
const ports = createLinkedPorts(
  (request) => {
    send(
      request.type === "post"
        ? { data: request.data, kind: "post", port: request.port }
        : { kind: "close", port: request.port },
    );
  },
  () => `c${next++}`,
);

/** Electron's `process.parentPort`. */
class ParentPort extends EventEmitter<{
  message: [event: { data: unknown; ports: MessagePortMain[] }];
}> {
  readonly postMessage = (message: unknown) => {
    send({ data: message, kind: "parent" });
  };
}

const parentPort = new ParentPort();

process.on("message", (message: UtilityMessage) => {
  switch (message.kind) {
    case "parent": {
      parentPort.emit("message", {
        data: message.data,
        ports: ports.take(message.ports ?? []),
      });
      break;
    }
    case "post": {
      ports.message(message.port, message.data);
      break;
    }
    case "close": {
      ports.closed(message.port);
      break;
    }
    case "ready": {
      break;
    }
  }
});

// The channel keeps the process alive until the module exits or the host
// kills it, and it goes with the host.
process.on("disconnect", () => process.exit());

const [modulePath, ...args] = process.argv.slice(2);
if (modulePath === undefined) {
  throw new Error(
    "usage: utility-process-child <module> [arguments…], as electron-host's utilityProcess.fork runs it",
  );
} else {
  Object.assign(process, { parentPort, type: "utility" });
  process.argv = [process.execPath, modulePath, ...args];
  // Not awaited at the top level: a message that comes while this module
  // still evaluates can be lost.
  void import(modulePath).then(() => {
    // Only now does the host send what the app had for the module: before,
    // the module has no listener on parentPort, and the message would be lost.
    send({ kind: "ready" });
  });
}
