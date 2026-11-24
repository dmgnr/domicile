// Electron's main process runs on past an error the app doesn't catch: it
// reports it and carries on, where Node and Bun would exit. Apps rely on
// that: one failed menu click must not close Slack.

import type { EventEmitter } from "node:events";

/** The app's own handler, if it added one, beside this one. */
const appHandles = (process: EventEmitter, event: string) =>
  process.listenerCount(event) > 1;

const describe = (thrown: unknown) =>
  thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);

/**
 * Keeps `process` running on an exception or rejection the app leaves
 * uncaught, passing it to `report`. One the app handles itself is the app's.
 */
export const keepRunningOnUncaughtErrors = (
  process: EventEmitter,
  report: (text: string) => void,
) => {
  process.on("uncaughtException", (error: unknown) => {
    if (!appHandles(process, "uncaughtException")) {
      report(
        `the main process runs on past an error nothing caught, as Electron's does: ${describe(error)}`,
      );
    }
  });
  process.on("unhandledRejection", (reason: unknown) => {
    if (!appHandles(process, "unhandledRejection")) {
      report(
        `the main process runs on past a rejection nothing handled, as Electron's does: ${describe(reason)}`,
      );
    }
  });
};
