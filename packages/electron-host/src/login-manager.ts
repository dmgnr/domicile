// logind on the system bus, for `powerMonitor`: its `PrepareForSleep` and
// `PrepareForShutdown` signals, and delay locks, as Electron takes them on
// Linux. A lock is a `systemd-inhibit` running `cat` on a pipe from this
// process, so it ends when the host does, however the host ends.

import type { MessageBus } from "dbus-next";
import { Message, systemBus } from "dbus-next";
import { z } from "zod";

import type { LogindSignals, LoginManager } from "./electron/power";
import { Priority, say } from "./journal";

/** Why each lock is held, in Electron's words, which `systemd-inhibit --list` shows. */
const WHY = {
  shutdown: "Ensure a clean shutdown",
  sleep: "Application cleanup before suspend",
} as const;

/** What logind's manager's signals carry: whether it starts. */
const startSchema = z.boolean();

/** `org.freedesktop.login1.Manager` as dbus-next's proxy hears it. */
type ManagerProxy = {
  readonly on: (
    signal: "PrepareForShutdown" | "PrepareForSleep",
    listener: (start: unknown) => void,
  ) => unknown;
};

/**
 * logind for app `who`, which names its locks. `connect` reaches the system
 * bus once the app first listens.
 */
export const connectLoginManager = (
  who: string,
  connect: () => MessageBus = systemBus,
): LoginManager => ({
  delay: (what) => {
    const child = Bun.spawn(
      [
        "systemd-inhibit",
        `--what=${what}`,
        "--mode=delay",
        `--who=${who}`,
        `--why=${WHY[what]}`,
        "cat",
      ],
      { stderr: "inherit", stdin: "pipe", stdout: "ignore" },
    );
    child.unref();
    return { stop: () => child.kill() };
  },
  follow: (signals) => {
    followLogind(connect(), signals).catch((error: unknown) => {
      say(
        Priority.Error,
        `electron-host: can't follow logind, so ${who} hears no suspend, resume or shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  },
});

/**
 * Hands `signals` each sleep and shutdown logind on `bus` says, resolving
 * once the bus sends them here.
 */
export const followLogind = async (bus: MessageBus, signals: LogindSignals) => {
  const logind = await bus.getProxyObject(
    "org.freedesktop.login1",
    "/org/freedesktop/login1",
  );
  // dbus-next types a proxy's members loosely; these are logind's own.
  const manager = logind.getInterface(
    "org.freedesktop.login1.Manager",
  ) as unknown as ManagerProxy;
  manager.on("PrepareForSleep", (start) => {
    signals.sleep(startSchema.parse(start));
  });
  manager.on("PrepareForShutdown", (start) => {
    signals.shutdown(startSchema.parse(start));
  });
  // The bus answers in order, so once it answers this it has the match
  // rules the listeners above asked for.
  await bus.call(
    new Message({
      destination: "org.freedesktop.DBus",
      interface: "org.freedesktop.DBus.Peer",
      member: "Ping",
      path: "/org/freedesktop/DBus",
    }),
  );
};
