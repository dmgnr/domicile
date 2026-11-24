import { describe, expect, it } from "bun:test";

import { inkOn } from "./profile-ink";

describe(inkOn, () => {
  it("writes white on a dark or saturated color", () => {
    expect(inkOn("#4338ca")).toBe("white");
    expect(inkOn("#0d9488")).toBe("white");
    expect(inkOn("#d97706")).toBe("white");
  });

  it("writes black on a light color, where white would not read", () => {
    expect(inkOn("#2bd96b")).toBe("black");
    expect(inkOn("#06b6d4")).toBe("black");
    expect(inkOn("#ffffff")).toBe("black");
  });
});
