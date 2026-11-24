import { z } from "zod";

// What the user did to the tray, stored locally as lists of `TrayEntry` keys:
// the icons' order, and which are unpinned. The compositor and engine each send
// icons in their own order. Every page of the desktop shares one origin, so
// they read the same stored lists.

/** The icons' order. Storage keys are versioned per the persisted-state rule. */
export const ORDER_KEY = "tray-order:v1";

/** The icons kept out of the tray, in its menu only. */
export const UNPINNED_KEY = "tray-unpinned:v1";

const keysSchema = z.array(z.string());

/**
 * The keys stored under `storageKey`, or none if nothing is stored.
 *
 * Parsed rather than cast: an unreadable value counts as none, so the tray
 * falls back to arrival order and every icon pinned.
 */
export const rememberedKeys = (storageKey: string): readonly string[] => {
  const stored = globalThis.localStorage.getItem(storageKey);
  return stored === null ? [] : parseKeys(stored);
};

/** Store `keys` under `storageKey` for other pages and future loads. */
export const rememberKeys = (
  storageKey: string,
  keys: readonly string[],
): void => {
  globalThis.localStorage.setItem(storageKey, JSON.stringify(keys));
};

/** `stored` as a list of keys, or none if it is not one. */
export const parseKeys = (stored: string): readonly string[] =>
  storedKeysSchema.safeParse(stored).data ?? [];

// Invalid JSON is a parse issue, not a throw, so it is handled like any other
// invalid value.
const storedKeysSchema = z
  .string()
  .transform((text, context): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(keysSchema);
