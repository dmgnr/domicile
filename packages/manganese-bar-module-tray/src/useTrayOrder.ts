import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ORDER_KEY,
  parseKeys,
  rememberedKeys,
  rememberKeys,
} from "./remembered-keys";
import { moveTo, place } from "./tray-order";

export type TrayOrder = {
  /** The user's tray order; see `arrange`. */
  order: readonly string[];
  /** Move `dragged` onto `target` among the `shown` keys; see `moveTo`. */
  move: (shown: readonly string[], dragged: string, target: string) => void;
};

/**
 * The tray icon order, stored on this machine.
 *
 * Held once per page, not per bar, so a drag on one monitor's bar applies to
 * all of them. Pages on other monitors receive it as a `storage` event.
 *
 * `shown` is the keys of every icon on the tray. New keys are placed and stored
 * on arrival, so a reopened application returns to its place.
 */
export const useTrayOrder = (shown: readonly string[]): TrayOrder => {
  const [order, setOrder] = useState(() => rememberedKeys(ORDER_KEY));

  useEffect(() => {
    const next = place(order, shown);
    if (next.length > order.length) {
      setOrder(next);
      rememberKeys(ORDER_KEY, next);
    }
  }, [order, shown]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ORDER_KEY) {
        setOrder(parseKeys(event.newValue ?? "[]"));
      }
    };
    globalThis.addEventListener("storage", onStorage);
    return () => {
      globalThis.removeEventListener("storage", onStorage);
    };
  }, []);

  const move = useCallback(
    (shown: readonly string[], dragged: string, target: string) => {
      const next = moveTo(order, shown, dragged, target);
      setOrder(next);
      rememberKeys(ORDER_KEY, next);
    },
    [order],
  );

  // Memoized, since every bar takes it.
  return useMemo(() => ({ move, order }), [move, order]);
};
