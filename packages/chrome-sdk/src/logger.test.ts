import { describe, expect, it } from "bun:test";
import type { LogSink } from "./logger";
import { logger } from "./logger";

const recording = () => {
  const said: [string, unknown[]][] = [];
  const sink: LogSink = {
    debug: (...line: unknown[]) => said.push(["debug", line]),
    error: (...line: unknown[]) => said.push(["error", line]),
    info: (...line: unknown[]) => said.push(["info", line]),
    warn: (...line: unknown[]) => said.push(["warn", line]),
  };
  return { said, sink };
};

describe("logger", () => {
  it("starts each line with its subsystem, at the level asked", () => {
    const { said, sink } = recording();
    const log = logger("notifications", sink);
    log.error("lost", 3);
    log.warn("odd");
    log.info("shown");
    log.debug("detail");
    expect(said).toEqual([
      ["error", ["[notifications]", "lost", 3]],
      ["warn", ["[notifications]", "odd"]],
      ["info", ["[notifications]", "shown"]],
      ["debug", ["[notifications]", "detail"]],
    ]);
  });

  it("refuses a subsystem the journal could not file", () => {
    expect(() => logger("two words")).toThrow(/letters, digits/);
    expect(() => logger("")).toThrow(/letters, digits/);
  });
});
