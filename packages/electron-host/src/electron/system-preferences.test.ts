import { describe, expect, it } from "bun:test";

import { createSystemPreferences } from "./system-preferences";

describe(createSystemPreferences, () => {
  it("gives the desktop's accent, and says each change to it", () => {
    const { accentColorChanged, systemPreferences } = createSystemPreferences(
      () => false,
      "#FF3300FF",
    );
    const heard: unknown[] = [];
    systemPreferences.on("accent-color-changed", (_event, color) =>
      heard.push(color),
    );

    expect(systemPreferences.getAccentColor()).toBe("#FF3300FF");
    accentColorChanged("#FF3300FF");
    accentColorChanged("");

    expect(heard).toEqual([""]);
    expect(systemPreferences.getAccentColor()).toBe("");
  });
});
