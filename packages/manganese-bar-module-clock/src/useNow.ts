import { useLayoutEffect, useRef, useState } from "react";

/** The wall clock; injectable so tests can freeze it. */
export const wallClock = (): Date => new Date();

/** A clock that shows seconds changes every second. */
export const SECOND_MS = 1000;

/** One that shows only minutes changes once a minute. */
export const MINUTE_MS = 60_000;

/**
 * The longest it waits between readings, whatever `step` is. Timers count on
 * a clock that stops while the machine sleeps, so a wait for the next minute
 * set before a sleep would leave the time from before it showing for most of
 * a minute after the wake (on the lock screen first). The wall clock can also
 * be set forward.
 */
const RECHECK_MS = 5000;

/** Which `step` a reading falls in. */
const stepOf = (time: Date, step: number): number =>
  Math.floor(time.getTime() / step);

/**
 * Reads `now` at each boundary of `step` and at least every
 * {@link RECHECK_MS}, handing a reading to `show` when it crosses into a new
 * step past `shown`. Returns what stops it.
 */
const tick = (
  now: typeof wallClock,
  step: number,
  shown: { current: Date },
  show: (time: Date) => void,
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = () => {
    const current = now();
    if (stepOf(current, step) !== stepOf(shown.current, step)) {
      shown.current = current;
      show(current);
    }
    timer = setTimeout(
      read,
      Math.min(step - (current.getTime() % step), RECHECK_MS),
    );
  };
  read();
  return () => {
    clearTimeout(timer);
  };
};

/**
 * The current time, changing on each boundary of `step` while mounted and
 * `running`: every second for a clock to the second, on the minute for one to
 * the minute. It reads the clock at each boundary, and at least every
 * {@link RECHECK_MS}, but only draws again when the reading crosses into a
 * new step, so a minute clock wakes the page a few times a minute instead of
 * every second.
 *
 * While not `running`, such as a clock on a hidden sheet, it does not read the
 * clock at all, and it reads it afresh before the first frame it runs again.
 */
export const useNow = (
  now: typeof wallClock = wallClock,
  step: number = SECOND_MS,
  running = true,
): Date => {
  const [time, setTime] = useState(() => now());
  // The reading shown, to tell when the next one crosses a step.
  const shown = useRef(time);

  // A layout effect, so a clock that starts running is right in its first
  // frame.
  useLayoutEffect(
    () => (running ? tick(now, step, shown, setTime) : undefined),
    [now, step, running],
  );

  return time;
};
