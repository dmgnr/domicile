import { useCallback, useEffect, useMemo, useState } from "react";

import {
  parseKeys,
  rememberedKeys,
  rememberKeys,
  UNPINNED_KEY,
} from "./remembered-keys";

export type TrayPins = {
  /** The keys of the icons kept out of the tray, in its menu only. */
  unpinned: ReadonlySet<string>;
  /** Put icon `key` back in the tray. */
  pin: (key: string) => void;
  /** Keep icon `key` out of the tray. */
  unpin: (key: string) => void;
};

/**
 * Which tray icons the user unpinned, stored on this machine.
 *
 * Unpinned rather than pinned, so a new icon arrives in the tray and nothing
 * goes missing on its own. Held once per page, like `useTrayOrder`, and
 * followed across pages by the `storage` event.
 */
export const useTrayPins = (): TrayPins => {
  const [unpinned, setUnpinned] = useState(() => rememberedKeys(UNPINNED_KEY));

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UNPINNED_KEY) {
        setUnpinned(parseKeys(event.newValue ?? "[]"));
      }
    };
    globalThis.addEventListener("storage", onStorage);
    return () => {
      globalThis.removeEventListener("storage", onStorage);
    };
  }, []);

  const change = useCallback((next: readonly string[]) => {
    setUnpinned(next);
    rememberKeys(UNPINNED_KEY, next);
  }, []);
  const pin = useCallback(
    (key: string) => {
      change(unpinned.filter((unpinnedKey) => unpinnedKey !== key));
    },
    [change, unpinned],
  );
  const unpin = useCallback(
    (key: string) => {
      if (!unpinned.includes(key)) {
        change([...unpinned, key]);
      }
    },
    [change, unpinned],
  );

  // Memoized, since every bar takes it.
  return useMemo(
    () => ({ pin, unpin, unpinned: new Set(unpinned) }),
    [pin, unpin, unpinned],
  );
};
