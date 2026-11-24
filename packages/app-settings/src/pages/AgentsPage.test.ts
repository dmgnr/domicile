import { describe, expect, it } from "bun:test";

import { addressHint } from "./AgentsPage";

describe("addressHint", () => {
  it("says what the relay is doing, problems first", () => {
    expect(addressHint(undefined)).toBe("Connecting to the relay…");
    expect(
      addressHint({
        address: "https://a/mcp",
        problem: undefined,
        ready: false,
      }),
    ).toMatch(/Getting your desktop ready/u);
    expect(
      addressHint({
        address: "https://a/mcp",
        problem: "Can't reach the relay: refused",
        ready: true,
      }),
    ).toBe("Can't reach the relay: refused");
    expect(
      addressHint({
        address: "https://a/mcp",
        problem: undefined,
        ready: true,
      }),
    ).toBe("Add it to the agent as a connector.");
  });
});
