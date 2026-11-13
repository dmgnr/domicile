import { describe, expect, it } from "bun:test";
import { Ok } from "@cprussin/option-result";

import { readSettings } from "./config-schema";

describe(readSettings, () => {
  it("fills in what a config leaves out as the compositor does", () => {
    const read = readSettings({});
    expect(read.map(({ files }) => files.omit)).toEqual(Ok(["**/.*"]));
    expect(read.map(({ input }) => input.keyboard.repeat)).toEqual(
      Ok({ delay_ms: 500, rate: 25 }),
    );
    expect(read.map(({ idle }) => idle)).toEqual(
      Ok({ blank_after_seconds: undefined, lock_after_seconds: undefined }),
    );
  });

  it("reads every key the compositor reads, such as mouse, touchpad and terminal", () => {
    const config = {
      input: {
        mouse: { natural_scroll: true },
        touchpad: { tap: false },
      },
      terminal: ["foot"],
    };
    const read = readSettings(config);
    expect(read.map(({ input }) => input.mouse.natural_scroll)).toEqual(
      Ok(true),
    );
    expect(read.map(({ input }) => input.touchpad.tap)).toEqual(Ok(false));
    expect(read.map(({ terminal }) => ({ terminal }))).toEqual(
      Ok({ terminal: ["foot"] }),
    );
  });

  it("says where a config does not fit", () => {
    expect(readSettings({ theme: { mode: "system" } }).isErr()).toBe(true);
    expect(readSettings({ theme: { tint: "red" } }).isErr()).toBe(true);
  });

  it("refuses numbers the compositor refuses", () => {
    for (const config of [
      { idle: { blank_after_seconds: 0 } },
      { theme: { cursor_size: 0 } },
      { theme: { cursor_hide_after_ms: 2 ** 32 } },
      { output: { max_scale: 0 } },
      {
        output: {
          profiles: [{ displays: [{ display: "a", scale: 0 }], name: "p" }],
        },
      },
      {
        output: {
          displays: [{ name: "a", position: [2 ** 31, 0], size: [1, 1] }],
        },
      },
    ]) {
      expect(readSettings(config).isErr()).toBe(true);
    }
  });
});
