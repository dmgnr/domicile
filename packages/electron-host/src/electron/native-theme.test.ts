import { describe, expect, it } from "bun:test";

import { createNativeTheme } from "./native-theme";

const LIGHT = { colorScheme: "light", highContrast: false } as const;
const DARK = { colorScheme: "dark", highContrast: false } as const;

describe(createNativeTheme, () => {
  it("follows the desktop's color scheme", () => {
    const { nativeTheme } = createNativeTheme(DARK);

    expect(nativeTheme.themeSource).toBe("system");
    expect(nativeTheme.shouldUseDarkColors).toBe(true);
    expect(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI).toBe(true);
    expect(nativeTheme.shouldUseHighContrastColors).toBe(false);
    expect(nativeTheme.shouldUseInvertedColorScheme).toBe(false);
    expect(nativeTheme.inForcedColorsMode).toBe(false);
    expect(nativeTheme.prefersReducedTransparency).toBe(false);
  });

  it("reads light with no preference, as GTK does", () => {
    const { nativeTheme } = createNativeTheme({
      colorScheme: "none",
      highContrast: false,
    });

    expect(nativeTheme.shouldUseDarkColors).toBe(false);
  });

  it("says when the desktop's appearance changes, and only then", () => {
    const { appearanceChanged, nativeTheme } = createNativeTheme(LIGHT);
    let updates = 0;
    nativeTheme.on("updated", () => {
      updates += 1;
    });

    appearanceChanged(LIGHT);
    expect(updates).toBe(0);

    appearanceChanged({ colorScheme: "dark", highContrast: true });
    expect(updates).toBe(1);
    expect(nativeTheme.shouldUseDarkColors).toBe(true);
    expect(nativeTheme.shouldUseHighContrastColors).toBe(true);
    expect(nativeTheme.inForcedColorsMode).toBe(true);
  });

  it("takes the app's own theme over the desktop's, until set back to system", () => {
    const { appearanceChanged, nativeTheme } = createNativeTheme(DARK);
    let updates = 0;
    nativeTheme.on("updated", () => {
      updates += 1;
    });

    nativeTheme.themeSource = "light";
    expect(nativeTheme.shouldUseDarkColors).toBe(false);
    // The bar and dialogs still follow the desktop.
    expect(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI).toBe(true);

    appearanceChanged(LIGHT);
    appearanceChanged(DARK);
    nativeTheme.themeSource = "system";

    expect(nativeTheme.shouldUseDarkColors).toBe(true);
    // Each source the app sets, as Electron does, and the desktop's changes.
    expect(updates).toBe(4);
  });

  it("refuses a theme source Electron has not", () => {
    const { nativeTheme } = createNativeTheme(LIGHT);

    expect(() => {
      Object.assign(nativeTheme, { themeSource: "sepia" });
    }).toThrow('themeSource must be "system", "light" or "dark"');
  });
});
