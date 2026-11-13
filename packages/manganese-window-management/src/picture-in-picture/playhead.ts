// Where a video in picture-in-picture is now. The page says its position when
// it changes, not as it plays, so the shell moves it on by its own clock.

/** What the page last said, and when the shell heard it (`at`, in ms). */
export type Heard = {
  at: number;
  /** Seconds; 0 is unknown or live. */
  duration: number;
  playing: boolean;
  /** Seconds. */
  position: number;
  rate: number;
};

/** The position, in seconds, at `now` (ms, on `at`'s clock). */
export const playheadAt = (
  { at, duration, playing, position, rate }: Heard,
  now: number,
): number =>
  playing
    ? Math.min(position + (rate * (now - at)) / 1000, duration)
    : position;

/** `seconds` as a clock reads: "1:42", or "1:02:03" past an hour. */
export const clockOf = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = (whole % 60).toString().padStart(2, "0");
  return hours > 0
    ? `${hours.toString()}:${minutes.toString().padStart(2, "0")}:${rest}`
    : `${minutes.toString()}:${rest}`;
};
