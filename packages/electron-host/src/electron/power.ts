// The stand-ins for Electron's `powerMonitor` and `powerSaveBlocker`.
//
// `powerMonitor` says when the desktop locks and unlocks, from
// `domicile subscribe status`, when the machine sleeps, wakes and shuts down,
// from logind, reads how long nobody has used it from `domicile idle-time`,
// and reads the battery from sysfs. `powerSaveBlocker` keeps the screens on
// with `domicile inhibit-idle`.

import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A running inhibitor, `domicile inhibit-idle` or a logind lock, which `stop` ends. */
export type Inhibitor = { readonly stop: () => void };

/** The fields of `domicile status --json` this reads. */
export type DesktopStatus = { readonly locked?: boolean };

const POWER_SUPPLY = "/sys/class/power_supply";

/** Whether the machine runs on a battery: one discharges and no mains is online. */
export const onBattery = (root = POWER_SUPPLY) => {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  const read = (name: string, field: string) => {
    try {
      return readFileSync(join(root, name, field), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  const mains = names.filter((name) => read(name, "type") === "Mains");
  if (mains.some((name) => read(name, "online") === "1")) {
    return false;
  }
  return names.some(
    (name) =>
      read(name, "type") === "Battery" &&
      read(name, "status") === "Discharging",
  );
};

/** What `org.freedesktop.login1.Manager` signals: each says whether it starts. */
export type LogindSignals = {
  readonly sleep: (start: boolean) => void;
  readonly shutdown: (start: boolean) => void;
};

/** logind, as `powerMonitor` follows it. */
export type LoginManager = {
  /** Hands `signals` each `PrepareForSleep` and `PrepareForShutdown`. */
  readonly follow: (signals: LogindSignals) => void;
  /** Takes a delay lock on `what`: logind waits until it is stopped. */
  readonly delay: (what: "sleep" | "shutdown") => Inhibitor;
};

/** The events logind says, which the monitor follows it for. */
const LOGIND_EVENTS: readonly (string | symbol)[] = [
  "resume",
  "shutdown",
  "suspend",
];

/**
 * Electron's `powerMonitor`. `statuses` hands each desktop status to its
 * argument; `idleSeconds` says how many whole seconds nobody has used the
 * desktop. As Electron, it holds sleep off with a delay lock until the app
 * has heard `suspend`, and shutdown while the app listens for `shutdown`,
 * past it when the app prevents it.
 */
export const createPowerMonitor = (
  statuses: (heard: (status: DesktopStatus) => void) => void,
  idleSeconds: () => number,
  logind: LoginManager,
  battery = onBattery,
) => {
  const monitor = new EventEmitter();
  let locked: boolean | undefined;
  let following = false;
  // Followed once the app listens or asks whether the desktop is locked.
  const follow = () => {
    if (!following) {
      following = true;
      statuses(heard);
    }
  };
  let sleepLock: Inhibitor | undefined;
  let shutdownLock: Inhibitor | undefined;
  let followingLogind = false;
  const followLogind = () => {
    if (!followingLogind) {
      followingLogind = true;
      sleepLock = logind.delay("sleep");
      logind.follow({
        shutdown: (start) => {
          if (start) {
            const event = eventObject();
            monitor.emit("shutdown", event);
            if (!event.defaultPrevented) {
              shutdownLock?.stop();
              shutdownLock = undefined;
            }
          }
        },
        sleep: (start) => {
          if (start) {
            monitor.emit("suspend");
            sleepLock?.stop();
            sleepLock = undefined;
          } else {
            sleepLock = logind.delay("sleep");
            monitor.emit("resume");
          }
        },
      });
    }
  };
  monitor.on("removeListener", (event: string | symbol) => {
    if (event === "shutdown" && monitor.listenerCount("shutdown") === 0) {
      shutdownLock?.stop();
      shutdownLock = undefined;
    }
  });
  monitor.on("newListener", (event: string | symbol) => {
    follow();
    if (LOGIND_EVENTS.includes(event)) {
      followLogind();
    }
    if (event === "shutdown" && shutdownLock === undefined) {
      shutdownLock = logind.delay("shutdown");
    }
  });
  const heard = (status: DesktopStatus) => {
    if (status.locked !== undefined && status.locked !== locked) {
      const first = locked === undefined;
      locked = status.locked;
      if (!first) {
        monitor.emit(locked ? "lock-screen" : "unlock-screen");
      }
    }
  };
  return Object.assign(monitor, {
    getCurrentThermalState: () => "unknown" as const,
    getSystemIdleState: (threshold: number) => {
      follow();
      if (locked === true) {
        return "locked" as const;
      }
      return idleSeconds() >= threshold
        ? ("idle" as const)
        : ("active" as const);
    },
    getSystemIdleTime: () => idleSeconds(),
    isOnBatteryPower: () => battery(),
    get onBatteryPower() {
      return battery();
    },
  });
};

/** Electron's `powerSaveBlocker`. `inhibit` keeps the screens on until stopped. */
export const createPowerSaveBlocker = (inhibit: () => Inhibitor) => {
  const blockers = new Map<number, Inhibitor>();
  let next = 0;
  return {
    isStarted: (id: number) => blockers.has(id),
    /** Both of Electron's types keep the screens on: Domicile has one idle. */
    start: (_type: "prevent-app-suspension" | "prevent-display-sleep") => {
      const id = next++;
      blockers.set(id, inhibit());
      return id;
    },
    stop: (id: number) => {
      const blocker = blockers.get(id);
      blocker?.stop();
      blockers.delete(id);
      return blocker !== undefined;
    },
  };
};

/** The event object Electron passes first to a listener. */
const eventObject = () => {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};
