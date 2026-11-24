// Every Electron event the host never fires, held against `events.json`. An
// app's listener on such an event looks like a working API: it is there,
// and nothing ever calls it. An event counts as fired when the sources of
// its emitter name it; one that opens, say from a new Electron version, or
// one the host starts firing, fails until the list is updated:
// `UPDATE_COVERAGE=1 bun test coverage`. See "Every API" in
// docs/architecture/ELECTRON-APPS.md.

import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";
import { z } from "zod";
import { ELECTRON_EVENTS } from "../electron/surface";

const EVENTS = join(import.meta.dir, "events.json");

/** The host's sources that fire each emitter's events. */
const SOURCES: Record<keyof typeof ELECTRON_EVENTS, readonly string[]> = {
  App: [
    "electron/app.ts",
    "electron/browser-window.ts",
    "electron/sign-ins.ts",
  ],
  AutoUpdater: ["electron/auto-updater.ts"],
  BaseWindow: ["electron/browser-window.ts"],
  BrowserWindow: ["electron/browser-window.ts", "electron/page-events.ts"],
  ClientRequest: ["electron/net.ts"],
  Cookies: ["electron/session-calls.ts"],
  Debugger: [],
  DownloadItem: ["electron/downloads.ts"],
  Extensions: [],
  IncomingMessage: ["electron/net.ts"],
  Menu: ["electron/menu.ts"],
  MessagePortMain: ["electron/message-port-main.ts"],
  NativeTheme: ["electron/native-theme.ts"],
  Notification: ["electron/notification.ts"],
  PowerMonitor: ["electron/power.ts"],
  Screen: ["electron/screen.ts"],
  ServiceWorkers: ["electron/service-workers.ts"],
  Session: [
    "electron/downloads.ts",
    "electron/session.ts",
    "electron/session-calls.ts",
  ],
  SystemPreferences: ["electron/system-preferences.ts"],
  Tray: ["electron/tray.ts"],
  UtilityProcess: ["electron/utility-process.ts"],
  View: ["electron/browser-window.ts"],
  WebContents: [
    "electron/browser-window.ts",
    "electron/ipc-main.ts",
    "electron/navigation.ts",
    "electron/page-events.ts",
    "electron/sign-ins.ts",
  ],
  WebContentsView: ["electron/browser-window.ts"],
  WebFrameMain: ["electron/browser-window.ts"],
};

/**
 * events.json: each event the host never fires, under `honest` when it has
 * nothing to report on Domicile, or `gaps` when an app misses it, each with
 * why.
 */
const EventDecisions = z.object({
  gaps: z.record(z.string(), z.string()),
  honest: z.record(z.string(), z.string()),
});

/** The events no source of their emitter names, as `Emitter.event`. */
const neverFired = async () => {
  const never: string[] = [];
  for (const [emitter, events] of Object.entries(ELECTRON_EVENTS)) {
    const sources = SOURCES[emitter as keyof typeof ELECTRON_EVENTS];
    const text = (
      await Promise.all(
        sources.map((source) =>
          readFile(join(import.meta.dir, "..", source), "utf8"),
        ),
      )
    ).join("\n");
    for (const event of events) {
      if (!text.includes(`"${event}"`)) {
        never.push(`${emitter}.${event}`);
      }
    }
  }
  return never.sort();
};

describe("Electron events", () => {
  it("never fired are what events.json lists", async () => {
    const never = await neverFired();
    const read = async () =>
      EventDecisions.parse(JSON.parse(await readFile(EVENTS, "utf8")));
    // biome-ignore lint/style/noProcessEnv: how a developer updates the list
    if (env.UPDATE_COVERAGE === "1") {
      const old = await read();
      const keep = (reasons: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(reasons).filter(([name]) => never.includes(name)),
        );
      const known = new Set([
        ...Object.keys(old.gaps),
        ...Object.keys(old.honest),
      ]);
      const added = never
        .filter((name) => !known.has(name))
        .map((name): [string, string] => [
          name,
          "new in Electron: the host doesn't fire it yet",
        ]);
      const gaps = Object.fromEntries(
        [...Object.entries(keep(old.gaps)), ...added].sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
      await writeFile(
        EVENTS,
        `${JSON.stringify({ gaps, honest: keep(old.honest) }, null, 2)}\n`,
      );
    }
    const decided = await read();
    expect(
      Object.keys(decided.gaps).filter((name) => name in decided.honest),
    ).toEqual([]);
    expect(never).toEqual(
      [...Object.keys(decided.gaps), ...Object.keys(decided.honest)].sort(),
    );
  });
});
