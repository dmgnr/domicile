// Whether the machine is online, for `net.isOnline`: what Chromium's netlink
// tracker answers on Linux, read from sysfs. Some link other than loopback or
// a tunnel is up and has a carrier.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SYS_CLASS_NET = "/sys/class/net";

/** `<linux/if.h>`'s flags `/sys/class/net/<link>/flags` holds. */
const IFF_UP = 0x1;
const IFF_LOOPBACK = 0x8;

/** Operational states of a link that is up, or whose driver doesn't say. */
const UP_STATES: readonly string[] = ["up", "unknown"];

export const isOnline = (root = SYS_CLASS_NET) =>
  readdirSync(root).some((name) => linkIsUp(join(root, name), name));

/**
 * Whether link `name` at `path` carries traffic. Its carrier is read last:
 * the kernel refuses to say for a link the user took down.
 */
const linkIsUp = (path: string, name: string) => {
  const flags = Number.parseInt(read(path, "flags"), 16);
  return (
    !name.startsWith("tun") &&
    (flags & IFF_LOOPBACK) === 0 &&
    (flags & IFF_UP) !== 0 &&
    UP_STATES.includes(read(path, "operstate")) &&
    read(path, "carrier") === "1"
  );
};

const read = (path: string, field: string) =>
  readFileSync(join(path, field), "utf8").trim();
