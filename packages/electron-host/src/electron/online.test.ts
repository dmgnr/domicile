import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isOnline } from "./online";

/** A `/sys/class/net` holding `links`, each its files by name. */
const links = (entries: Record<string, Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "class-net-"));
  for (const [name, fields] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    for (const [field, value] of Object.entries(fields)) {
      writeFileSync(join(root, name, field), `${value}\n`);
    }
  }
  return root;
};

const LOOPBACK = { carrier: "1", flags: "0x9", operstate: "unknown" };

describe(isOnline, () => {
  it("is online while a link other than loopback is up with a carrier, as Chromium reads netlink", () => {
    expect(
      isOnline(
        links({
          lo: LOOPBACK,
          wlan0: { carrier: "1", flags: "0x1003", operstate: "up" },
        }),
      ),
    ).toBe(true);
    expect(
      isOnline(
        links({
          enp0s1: { carrier: "0", flags: "0x1003", operstate: "down" },
          lo: LOOPBACK,
          // Down by the user: reading its carrier fails, so it isn't read.
          wlan0: { flags: "0x1002", operstate: "down" },
        }),
      ),
    ).toBe(false);
  });

  it("doesn't count a tunnel, as Chromium doesn't", () => {
    expect(
      isOnline(
        links({
          lo: LOOPBACK,
          tun0: { carrier: "1", flags: "0x1091", operstate: "unknown" },
        }),
      ),
    ).toBe(false);
  });
});
