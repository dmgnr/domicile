import { useContext, useRef } from "react";

import { cva, cx } from "../styled-system/css";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { SlidingScreen } from "./sliding-screen";
import { useLowered } from "./useLowered";
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
  /** Its `z-index`, under the windows in it. See `wellDepthOf`. */
  depth: number;
  /** Whether its group is being dragged, so it follows the pointer. */
  dragging: boolean;
  /**
   * Whether it casts its float's shadow, as the float's outermost well. See
   * `castsFloatShadow`.
   */
  castsShadow: boolean;
  /** The motion of its tab, which it plays too. */
  motion: WindowMotion;
  /**
   * Whether it is inside another group's well, which draws its edge stronger.
   * See `StripPlace.nested`.
   */
  nested: boolean;
  /** The box under the strip. See `Tab.well`. */
  rect: Rect;
  /** Its tab's restack animation, which it plays too. */
  restack?: Restack | undefined;
};

/**
 * The backdrop of a group shown in a tab: the open tab's color, hanging from
 * it, with a margin around the group's windows. See `Tab.well`.
 *
 * Drawn before every window and glow, at or under their depth, so they cover
 * it.
 */
export const GroupWell = ({
  castsShadow,
  depth,
  dragging,
  motion,
  nested,
  rect,
  restack,
}: Props) => {
  const element = useRef<HTMLDivElement>(null);
  const lowered = useLowered(depth);
  const sliding = useContext(SlidingScreen);
  useSettling({
    element,
    origin: originOf(rect, rect),
    rect,
    still: dragging || isMoving(motion),
  });
  return (
    <div
      className={cx(
        wellStyles({ castsShadow, nested }),
        movingStyles({ motion }),
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      data-well
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

/**
 * The open tab's background and edge (see `tabStyles` in `TitleBar`), with no
 * top edge, so the two read as one piece. Rounded at the bottom like a window.
 */
const wellStyles = cva({
  base: {
    backgroundColor:
      "color-mix(in oklab, {colors.foreground} 14%, {colors.background})",
    // Longhands, as for `edgeStyles`.
    borderBlockEndWidth: "1px",
    borderBlockStartWidth: 0,
    borderEndEndRadius: "lg",
    borderEndStartRadius: "lg",
    borderInlineWidth: "1px",
    borderStyle: "solid",
    pointerEvents: "none",
  },
  variants: {
    castsShadow: { false: {}, true: { boxShadow: "lifted" } },
    // As its strip's open tab draws it. See `TabStrip`.
    nested: {
      false: { borderColor: "borderStrong" },
      true: {
        borderColor:
          "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
      },
    },
  },
});
