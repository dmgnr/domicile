import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ringBell, waylandSocket } from "./wayland-bell";

/** A Wayland message: `object`, `opcode`, then its words and strings. */
const wire = (object: number, opcode: number, args: (number | string)[]) => {
  const body = Buffer.concat(
    args.map((arg) => {
      if (typeof arg === "number") {
        const word = Buffer.alloc(4);
        word.writeUInt32LE(arg);
        return word;
      } else {
        const text = Buffer.from(`${arg}\0`);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(text.length);
        return Buffer.concat([
          length,
          text,
          Buffer.alloc((4 - (text.length % 4)) % 4),
        ]);
      }
    }),
  );
  const header = Buffer.alloc(8);
  header.writeUInt32LE(object);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
};

let server: ReturnType<typeof Bun.listen> | undefined;

afterEach(() => {
  server?.stop(true);
});

/**
 * A compositor at a socket that lists `globals` and answers each sync,
 * keeping every byte the client sent after the first sync, or refuses the
 * client with `refuse`.
 */
const compositor = async (globals: [number, string][], refuse?: string) => {
  const socket = join(
    await mkdtemp(join(tmpdir(), "electron-host-bell-")),
    "wayland-0",
  );
  const heard: Buffer[] = [];
  let listed = false;
  server = Bun.listen({
    socket: {
      data: (connection, chunk) => {
        if (refuse !== undefined) {
          connection.write(wire(1, 0, [1, 1, refuse]));
        } else if (listed) {
          heard.push(Buffer.from(chunk));
          // The client's last request is the sync on callback 5.
          connection.write(wire(5, 0, [0]));
        } else {
          listed = true;
          connection.write(
            Buffer.concat([
              ...globals.map(([name, iface]) => wire(2, 0, [name, iface, 1])),
              wire(3, 0, [0]),
            ]),
          );
        }
      },
    },
    unix: socket,
  });
  return { heard, socket };
};

describe(ringBell, () => {
  it("binds the compositor's bell and rings it for no window", async () => {
    const { heard, socket } = await compositor([
      [1, "wl_compositor"],
      [7, "xdg_system_bell_v1"],
    ]);

    await ringBell(socket);

    expect(Buffer.concat(heard)).toEqual(
      Buffer.concat([
        wire(2, 0, [7, "xdg_system_bell_v1", 1, 4]),
        wire(4, 1, [0]),
        wire(4, 0, []),
        wire(1, 0, [5]),
      ]),
    );
  });

  it("fails when the compositor has no bell", async () => {
    const { socket } = await compositor([[1, "wl_compositor"]]);

    expect(ringBell(socket)).rejects.toThrow(
      "the compositor has no xdg_system_bell_v1",
    );
  });

  it("fails with why the compositor refused", async () => {
    const { socket } = await compositor([], "invalid object 2");

    expect(ringBell(socket)).rejects.toThrow(
      "the compositor refused: invalid object 2",
    );
  });
});

describe(waylandSocket, () => {
  it("finds the compositor's socket as libwayland does", () => {
    expect(
      waylandSocket({
        WAYLAND_DISPLAY: "wayland-1",
        XDG_RUNTIME_DIR: "/run/u",
      }),
    ).toBe("/run/u/wayland-1");
    expect(waylandSocket({ XDG_RUNTIME_DIR: "/run/u" })).toBe(
      "/run/u/wayland-0",
    );
    expect(waylandSocket({ WAYLAND_DISPLAY: "/tmp/w" })).toBe("/tmp/w");
    expect(() => waylandSocket({})).toThrow("XDG_RUNTIME_DIR isn't set");
  });
});
