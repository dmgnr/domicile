import { useContext, useRef } from "react";

import { cva, cx } from "../../styled-system/css";
import type { Rect } from "../rect";
import type { Restack } from "../restacking";
import { SlidingScreen } from "../sliding-screen";
import { useLowered } from "../useLowered";
import type { Settler } from "../useSettling";
import { useSettling } from "../useSettling";
import type { WindowMotion } from "../window-motion";
import { isMoving } from "../window-motion";
import {
  clippedAlong,
  heldStyles,
  movingStyles,
  originOf,
  placedAt,
  scaledAbout,
  settlingStyles,
  shuffledBy,
} from "../window-styles";

type Props = {
  /** The stacking depth of the window casting it. */
  depth: number;
  /** Whether the window is being dragged, so the shadow follows the pointer. */
  dragging: boolean;
  /** The window's whole box, bar included. */
  frame: Rect;
  /**
   * Whether the window hangs from the screen's top edge, as a scratchpad
   * window does, which squares its top corners.
   */
  hanging?: boolean;
  /** The window's motion, which the shadow plays too. */
  motion: WindowMotion;
  /** The window's restack animation, if any. */
  restack?: Restack | undefined;
  /** Eases the shadow into a new box with its window; see `useSettling`. */
  settler?: Settler | undefined;
};

/**
 * The shadow a floating window casts.
 *
 * A separate element over the whole frame, since shadows on the bar and the
 * contents separately would overlap each other at the seam.
 *
 * Drawn at the window's depth but before every window in the document, so its
 * window covers it by document order. It animates and moves with the window.
 */
export const FloatShadow = ({
  depth,
  dragging,
  frame,
  hanging = false,
  motion,
  restack,
  settler,
}: Props) => {
  const element = useRef<HTMLDivElement>(null);
  const lowered = useLowered(depth);
  const sliding = useContext(SlidingScreen);
  useSettling({
    element,
    origin: originOf(frame, frame),
    rect: frame,
    settler,
    still: dragging || isMoving(motion),
  });
  return (
    <div
      className={cx(
        shadowStyles({ hanging }),
        movingStyles({ motion }),
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      data-shadow
      ref={element}
      style={{
        ...placedAt(frame, depth),
        ...clippedAlong(sliding, frame),
        ...scaledAbout(frame, frame),
        ...shuffledBy(restack),
      }}
    />
  );
};

/**
 * An outer `box-shadow` only, which is never drawn under its own box. Rounded
 * like the frame, and ignores the pointer.
 */
const shadowStyles = cva({
  base: { boxShadow: "lifted", pointerEvents: "none" },
  variants: {
    hanging: {
      false: { borderRadius: "lg" },
      true: { borderEndEndRadius: "lg", borderEndStartRadius: "lg" },
    },
  },
});
