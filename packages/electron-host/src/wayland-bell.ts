// Rings the desktop's bell over Wayland's `xdg_system_bell_v1`, for
// `shell.beep`: the compositor tells the shell, which decides what a bell
// sounds or looks like. A short-lived client speaks just enough of the wire
// protocol to bind the bell, ring it once for no window, and see it arrive.

import { isAbsolute, join } from "node:path";

import type { Environment } from "./environment";

const DISPLAY = 1;
const REGISTRY = 2;
const LISTED = 3;
const BELL = 4;
const RUNG = 5;

const BELL_INTERFACE = "xdg_system_bell_v1";

/** One message on the wire: the object it's for, its opcode and its arguments. */
type WaylandMessage = {
  readonly object: number;
  readonly opcode: number;
  readonly body: Buffer;
};

/** The compositor's socket, found from the environment as libwayland finds it. */
export const waylandSocket = ({
  WAYLAND_DISPLAY: display = "wayland-0",
  XDG_RUNTIME_DIR: runtime,
}: Pick<Environment, "WAYLAND_DISPLAY" | "XDG_RUNTIME_DIR">) => {
  if (isAbsolute(display)) {
    return display;
  } else if (runtime === undefined) {
    throw new Error(
      "XDG_RUNTIME_DIR isn't set, so there's no compositor's socket to ring the bell on",
    );
  } else {
    return join(runtime, display);
  }
};

/** Rings the bell of the compositor listening at `socket`, once. */
export const ringBell = (socket: string) =>
  new Promise<void>((resolve, reject) => {
    let pending: Buffer = Buffer.alloc(0);
    let bell: number | undefined;
    Bun.connect({
      socket: {
        close: () => {
          reject(new Error("the compositor hung up before the bell rang"));
        },
        data: (connection, chunk) => {
          pending = Buffer.concat([pending, chunk]);
          const { messages, rest } = readMessages(pending);
          pending = rest;
          for (const message of messages) {
            if (message.object === DISPLAY && message.opcode === 0) {
              reject(
                new Error(`the compositor refused: ${displayError(message)}`),
              );
              connection.end();
            } else if (message.object === REGISTRY && message.opcode === 0) {
              const global = readGlobal(message.body);
              if (global.interface === BELL_INTERFACE) {
                bell = global.name;
              }
            } else if (message.object === LISTED && message.opcode === 0) {
              if (bell === undefined) {
                reject(new Error(`the compositor has no ${BELL_INTERFACE}`));
                connection.end();
              } else {
                connection.write(
                  Buffer.concat([
                    request(REGISTRY, 0, [
                      uint(bell),
                      string(BELL_INTERFACE),
                      uint(1),
                      uint(BELL),
                    ]),
                    request(BELL, 1, [uint(0)]),
                    request(BELL, 0, []),
                    request(DISPLAY, 0, [uint(RUNG)]),
                  ]),
                );
              }
            } else if (message.object === RUNG && message.opcode === 0) {
              resolve();
              connection.end();
            }
          }
        },
        error: (_connection, error) => {
          reject(error);
        },
        open: (connection) => {
          connection.write(
            Buffer.concat([
              request(DISPLAY, 1, [uint(REGISTRY)]),
              request(DISPLAY, 0, [uint(LISTED)]),
            ]),
          );
        },
      },
      unix: socket,
    }).catch(reject);
  });

/** The whole messages at the start of `bytes`, and what's left of the next. */
const readMessages = (bytes: Buffer) => {
  const messages: WaylandMessage[] = [];
  let at = 0;
  while (bytes.length - at >= 8) {
    const size = bytes.readUInt32LE(at + 4) >>> 16;
    if (bytes.length - at < size) {
      break;
    }
    messages.push({
      body: bytes.subarray(at + 8, at + size),
      object: bytes.readUInt32LE(at),
      opcode: bytes.readUInt32LE(at + 4) & 0xff_ff,
    });
    at += size;
  }
  return { messages, rest: bytes.subarray(at) };
};

/** A request to `object` with `opcode` and its encoded arguments. */
const request = (object: number, opcode: number, args: readonly Buffer[]) => {
  const body = Buffer.concat(args);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(object, 0);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
};

const uint = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

/** A string argument: its length with the NUL, then it, padded to four bytes. */
const string = (value: string) => {
  const text = Buffer.from(`${value}\0`);
  return Buffer.concat([
    uint(text.length),
    text,
    Buffer.alloc((4 - (text.length % 4)) % 4),
  ]);
};

/** A string argument at `at` in `body`, and where the next one starts. */
const readString = (body: Buffer, at: number) => {
  const length = body.readUInt32LE(at);
  return {
    next: at + 4 + length + ((4 - (length % 4)) % 4),
    value: body.subarray(at + 4, at + 4 + length - 1).toString("utf8"),
  };
};

/** `wl_registry.global`'s name and interface. */
const readGlobal = (body: Buffer) => ({
  interface: readString(body, 4).value,
  name: body.readUInt32LE(0),
});

/** `wl_display.error`'s message. */
const displayError = (message: WaylandMessage) =>
  readString(message.body, 8).value;
