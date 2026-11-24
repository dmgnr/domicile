import { use } from "react";

import { css } from "../styled-system/css";
import { ClockOptionsContext } from "./clock-options";
import { reading } from "./reading";
import type { wallClock } from "./useNow";
import { MINUTE_MS, SECOND_MS, useNow } from "./useNow";

type Props = {
  now?: typeof wallClock | undefined;
};

/**
 * The live clock, centered in the top bar or alone on a screen without one,
 * told as {@link ClockOptionsContext} says.
 */
export const Clock = ({ now }: Props) => {
  const options = use(ClockOptionsContext);
  const time = useNow(now, options.seconds ? SECOND_MS : MINUTE_MS);

  return (
    <time className={clockStyles} dateTime={time.toISOString()}>
      {reading(time, options)}
    </time>
  );
};

// No color, so it inherits the bar's white or the page's foreground.
const clockStyles = css({
  // 13px, the desktop's text size, between the scale's 12px and 14px.
  fontSize: "ui",
  // Fixed-width digits, so the bar does not jitter every second.
  fontVariantNumeric: "tabular-nums",
  fontWeight: "medium",
  whiteSpace: "nowrap",
});
