// Electron's single-instance lock, `app.requestSingleInstanceLock`, which
// answers synchronously. The first instance writes a lock in the app's
// `userData` naming itself; a later one finds it held, leaves its launch in
// the inbox beside it for the first's `second-instance`, and is told no.

import type { FSWatcher } from "node:fs";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** What a later instance hands the first: `second-instance`'s arguments. */
export type SecondInstance = {
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly additionalData: unknown;
};

/** In `userData`. Not Chromium's names, which the app's own Electron owns. */
export const LOCK = "DomicileSingletonLock";
export const INBOX = "DomicileSingletonInbox";

/**
 * A process, as `/proc` names it: its pid and its start time, so a pid used
 * again by another process doesn't hold the lock.
 */
const identity = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22, counted after the command name, which may hold spaces.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${pid} ${start}`;
  } catch {
    return undefined;
  }
};

/**
 * The lock for the app whose `userData` is `dir()`. `heard` gets each later
 * instance's launch while this one holds it.
 */
export const createSingleInstanceLock = (
  dir: () => string,
  heard: (launch: SecondInstance) => void,
  self = process.pid,
) => {
  let watcher: FSWatcher | undefined;
  let held: string | undefined;

  const readInbox = (inbox: string) => {
    for (const name of readdirSync(inbox).sort()) {
      if (name.endsWith(".json")) {
        const path = join(inbox, name);
        const launch = JSON.parse(readFileSync(path, "utf8")) as SecondInstance;
        rmSync(path);
        heard(launch);
      }
    }
  };

  return {
    has: () => held !== undefined,
    release: () => {
      watcher?.close();
      watcher = undefined;
      if (held !== undefined) {
        rmSync(held, { force: true });
      }
      held = undefined;
    },
    /** Takes the lock, or leaves `launch` for the instance holding it and answers false. */
    request: (launch: SecondInstance): boolean => {
      if (held !== undefined) {
        return true;
      }
      const userData = dir();
      const lock = join(userData, LOCK);
      const inbox = join(userData, INBOX);
      mkdirSync(inbox, { recursive: true });
      let holder: string | undefined;
      try {
        holder = readFileSync(lock, "utf8").trim();
      } catch {
        holder = undefined;
      }
      const holderPid = Number(holder?.split(" ")[0]);
      if (holder !== undefined && identity(holderPid) === holder) {
        const name = `${Date.now()}-${self}`;
        writeFileSync(join(inbox, `${name}.tmp`), JSON.stringify(launch));
        renameSync(join(inbox, `${name}.tmp`), join(inbox, `${name}.json`));
        return false;
      }
      const mine = identity(self);
      if (mine === undefined) {
        throw new Error(
          `can't read /proc/${self}/stat to take the single-instance lock`,
        );
      }
      writeFileSync(`${lock}.${self}`, mine);
      renameSync(`${lock}.${self}`, lock);
      held = lock;
      // Launches left while no instance ran are stale.
      for (const name of readdirSync(inbox)) {
        rmSync(join(inbox, name));
      }
      watcher = watch(inbox, () => readInbox(inbox));
      return true;
    },
  };
};
