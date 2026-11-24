import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import { keepRunningOnUncaughtErrors } from "./uncaught-errors";

/** A process whose uncaught errors are reported into `said`. */
const setUp = () => {
  const said: string[] = [];
  const process = new EventEmitter();
  keepRunningOnUncaughtErrors(process, (text) => said.push(text));
  return { process, said };
};

describe(keepRunningOnUncaughtErrors, () => {
  it("reports an exception the app doesn't catch, with its stack", () => {
    const { process, said } = setUp();
    const error = new Error('Executable not found in $PATH: "wl-copy"');

    process.emit("uncaughtException", error);

    expect(said).toEqual([
      `the main process runs on past an error nothing caught, as Electron's does: ${error.stack}`,
    ]);
  });

  it("reports a rejection the app doesn't handle", () => {
    const { process, said } = setUp();

    process.emit("unhandledRejection", "no reason");

    expect(said).toEqual([
      "the main process runs on past a rejection nothing handled, as Electron's does: no reason",
    ]);
  });

  it("leaves an exception to the app's own handler", () => {
    const { process, said } = setUp();
    process.on("uncaughtException", () => undefined);

    process.emit("uncaughtException", new Error("handled"));

    expect(said).toEqual([]);
  });

  it("leaves a rejection to the app's own handler", () => {
    const { process, said } = setUp();
    process.on("unhandledRejection", () => undefined);

    process.emit("unhandledRejection", new Error("handled"));

    expect(said).toEqual([]);
  });
});
