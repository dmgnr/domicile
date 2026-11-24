import type { MouseEvent, PointerEvent, RefObject } from "react";
import { useEffect, useRef } from "react";

/** How long a press is held before it counts as long, as Chrome's. */
const LONG_PRESS_MS = 500;

/** `PointerEvent.button` for the primary button. */
const PRIMARY_BUTTON = 0;

type Timer = ReturnType<typeof setTimeout> | undefined;

/**
 * Handlers that call `onLongPress` once the primary button is held on an
 * element, and `onClick` for a click that was not one. When `onLongPress`
 * answers that it acted, the press's own release click is dropped. A click
 * from the keyboard is never dropped.
 */
export const useLongPress = (
  onLongPress: () => boolean,
  onClick: (event: MouseEvent) => void,
) => {
  const timer = useRef<Timer>(undefined);
  // Whether the press in progress went long, so its click is dropped.
  const pressedLong = useRef(false);

  useEffect(
    () => () => {
      cancel(timer);
    },
    [],
  );

  const stop = () => {
    cancel(timer);
  };

  return {
    onClick: (event: MouseEvent) => {
      // `detail` 0 is a click from the keyboard, which no press precedes.
      const dropped = pressedLong.current && event.detail !== 0;
      pressedLong.current = false;
      if (!dropped) {
        onClick(event);
      }
    },
    onPointerCancel: stop,
    onPointerDown: (event: PointerEvent) => {
      if (event.button === PRIMARY_BUTTON) {
        pressedLong.current = false;
        cancel(timer);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          pressedLong.current = onLongPress();
        }, LONG_PRESS_MS);
      }
    },
    onPointerLeave: stop,
    onPointerUp: stop,
  };
};

/** Stops the pending long press, if any. */
const cancel = (timer: RefObject<Timer>) => {
  clearTimeout(timer.current);
  timer.current = undefined;
};
