// The desktop's appearance, for `nativeTheme` and `systemPreferences`: the
// settings portal's `org.freedesktop.appearance` keys, as Electron reads them
// on Linux. See "Settings" in docs/PORTALS.md.

import { z } from "zod";

import type { Appearance } from "./electron/native-theme";

const NAMESPACE = "org.freedesktop.appearance";

/** What this reads of `org.freedesktop.portal.Settings`. */
export type PortalSettings = {
  readonly ReadOne: (
    namespace: string,
    key: string,
  ) => Promise<{ readonly value: unknown }>;
  readonly on: (
    event: "SettingChanged",
    listener: (
      namespace: string,
      key: string,
      value: { readonly value: unknown },
    ) => void,
  ) => unknown;
};

const COLOR_SCHEMES: Readonly<Record<number, Appearance["colorScheme"]>> = {
  0: "none",
  1: "dark",
  2: "light",
};

/** `color-scheme`'s value, read loudly: the portal is the desktop's own. */
const colorSchemeOf = (value: unknown) => {
  const scheme = typeof value === "number" ? COLOR_SCHEMES[value] : undefined;
  if (scheme === undefined) {
    throw new Error(
      `the settings portal sent color-scheme ${JSON.stringify(value)}, which is none of 0, 1 or 2`,
    );
  }
  return scheme;
};

const highContrastOf = (value: unknown) => {
  if (value !== 0 && value !== 1) {
    throw new Error(
      `the settings portal sent contrast ${JSON.stringify(value)}, which is neither 0 nor 1`,
    );
  }
  return value === 1;
};

/**
 * Reads the desktop's appearance from `settings`, then hands `changed` each
 * new one the portal sends.
 */
export const watchAppearance = async (
  settings: PortalSettings,
  changed: (appearance: Appearance) => void,
): Promise<Appearance> => {
  const [scheme, contrast] = await Promise.all([
    settings.ReadOne(NAMESPACE, "color-scheme"),
    settings.ReadOne(NAMESPACE, "contrast"),
  ]);
  let appearance: Appearance = {
    colorScheme: colorSchemeOf(scheme.value),
    highContrast: highContrastOf(contrast.value),
  };
  settings.on("SettingChanged", (namespace, key, { value }) => {
    if (namespace === NAMESPACE && key === "color-scheme") {
      appearance = { ...appearance, colorScheme: colorSchemeOf(value) };
      changed(appearance);
    } else if (namespace === NAMESPACE && key === "contrast") {
      appearance = { ...appearance, highContrast: highContrastOf(value) };
      changed(appearance);
    }
  });
  return appearance;
};

/** `accent-color`: red, green and blue, each 0 to 1, or out of range for none. */
const accentSchema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * `accent-color` as Electron's `getAccentColor` gives it, `#RRGGBBAA`, or ""
 * for none: the spec reads a channel outside 0 to 1 as no accent.
 */
const accentColorOf = (value: unknown) => {
  const parsed = accentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `the settings portal sent accent-color ${JSON.stringify(value)}, which is not three channels`,
    );
  } else if (parsed.data.some((channel) => channel < 0 || channel > 1)) {
    return "";
  } else {
    return `#${[...parsed.data.map((channel) => Math.round(channel * 255)), 255]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
};

/**
 * Reads the desktop's accent color from `settings`, then hands `changed`
 * each new one the portal sends.
 */
export const watchAccentColor = async (
  settings: PortalSettings,
  changed: (color: string) => void,
): Promise<string> => {
  const { value } = await settings.ReadOne(NAMESPACE, "accent-color");
  const color = accentColorOf(value);
  settings.on("SettingChanged", (namespace, key, changedTo) => {
    if (namespace === NAMESPACE && key === "accent-color") {
      changed(accentColorOf(changedTo.value));
    }
  });
  return color;
};
