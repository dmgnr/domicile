import { useContext, useRef } from "react";

import { css, cx } from "../styled-system/css";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { SlidingScreen } from "./sliding-screen";
import { useLowered } from "./useLowered";
import type { Settler } from "./useSettling";
import { useSettling } from "./useSettling";
import type { WindowMotion } from "./window-motion";
import { isMoving } from "./window-motion";
import {
  clippedAlong,
  heldStyles,
  movingStyles,
  originOf,
  placedAt,
  scaledAbout,
  settlingStyles,
  shuffledBy,
} from "./window-styles";

type Props = {
  /** Its `z-index`: the open tab's, over the windows it tints. See `raised`. */
  depth: number;
  /** Whether the selection is being dragged, so it follows the pointer. */
  dragging: boolean;
  /** The focused window's motion, which the tint plays too. */
  motion: WindowMotion;
  /** The selected container's box. See `FocusBox.selection`. */
  rect: Rect;
  /** The focused window's restack shuffle, if any. */
  restack?: Restack | undefined;
  /** Eases the tint into a new box with its windows; see `useSettling`. */
  settler?: Settler | undefined;
};

/**
 * An accent wash over the container `focus parent` selected: its tabs, its
 * windows and the gaps between them.
 *
 * - It sits at the open tab's depth after every window and tab in the
 *   document, so it covers them and windows stacked above stay above.
 * - It plays the focused window's motion, moves with its windows, and takes
 *   no pointer events.
 */
export const SelectionTint = ({
  depth,
  dragging,
  motion,
  rect,
  restack,
  settler,
}: Props) => {
  const element = useRef<HTMLDivElement>(null);
  const lowered = useLowered(depth);
  const sliding = useContext(SlidingScreen);
  useSettling({
    element,
    origin: originOf(rect, rect),
    rect,
    settler,
    still: dragging || isMoving(motion),
  });
  return (
    <div
      className={cx(
        tintStyles,
        movingStyles({ motion }),
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      data-selection
      ref={element}
      style={{
        ...placedAt(rect, depth),
        ...clippedAlong(sliding, rect),
        ...scaledAbout(rect, rect),
        ...shuffledBy(restack),
      }}
    />
  );
};

/** Rounded like a window's frame. Light, so the windows stay readable. */
const tintStyles = css({
  _starting: { opacity: 0 },
  backgroundColor: "color-mix(in oklab, {colors.accent} 15%, transparent)",
  borderRadius: "lg",
  pointerEvents: "none",
});
