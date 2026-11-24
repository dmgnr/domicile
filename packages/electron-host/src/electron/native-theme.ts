// The stand-in for Electron's `nativeTheme`: the desktop's appearance, from
// the settings portal (see src/appearance.ts), and the app's own choice.

import { EventEmitter } from "node:events";

/** What the desktop says of its look. */
export type Appearance = {
  readonly colorScheme: "dark" | "light" | "none";
  readonly highContrast: boolean;
};

export type ThemeSource = "system" | "light" | "dark";

const SOURCES: readonly unknown[] = ["system", "light", "dark"];

/**
 * Electron's `nativeTheme`, starting at the desktop's `initial` appearance.
 * `appearanceChanged` takes each change the desktop sends.
 */
export const createNativeTheme = (initial: Appearance) => {
  let appearance = initial;
  let source: ThemeSource = "system";

  class NativeTheme extends EventEmitter<{ updated: [] }> {
    get themeSource(): ThemeSource {
      return source;
    }

    set themeSource(value: ThemeSource) {
      if (!SOURCES.includes(value)) {
        throw new TypeError(
          `themeSource must be "system", "light" or "dark", not ${JSON.stringify(value)}`,
        );
      }
      change(() => {
        source = value;
      });
    }

    get shouldUseDarkColors() {
      return source === "system"
        ? appearance.colorScheme === "dark"
        : source === "dark";
    }

    /** The desktop's own, whatever the app chose. */
    get shouldUseDarkColorsForSystemIntegratedUI() {
      return appearance.colorScheme === "dark";
    }

    get shouldUseHighContrastColors() {
      return appearance.highContrast;
    }

    get inForcedColorsMode() {
      return appearance.highContrast;
    }

    get shouldUseInvertedColorScheme() {
      return false;
    }

    get prefersReducedTransparency() {
      return false;
    }
  }

  const nativeTheme = new NativeTheme();

  /** What an app reads, to tell whether a change shows. */
  const seen = () =>
    [
      nativeTheme.shouldUseDarkColors,
      nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
      nativeTheme.shouldUseHighContrastColors,
      nativeTheme.themeSource,
    ].join();

  /** Makes a change, saying `updated` if it shows. */
  const change = (make: () => void) => {
    const before = seen();
    make();
    if (seen() !== before) {
      nativeTheme.emit("updated");
    }
  };

  return {
    appearanceChanged: (next: Appearance) => {
      change(() => {
        appearance = next;
      });
    },
    nativeTheme,
  };
};
