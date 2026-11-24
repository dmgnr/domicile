import { useContext, useRef } from "react";

import { css, cva, cx } from "../styled-system/css";
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
  /** The depth of the windows it lights. */
  depth: number;
  /**
   * Whether the focused window is being dragged, so the glow follows the
   * pointer without easing.
   */
  dragging: boolean;
  /** Whether focus has left the box, so the glow fades out. */
  leaving: boolean;
  /** The focused window's motion, which the glow plays too. */
  motion: WindowMotion;
  /** Called when a fade in or out ends. */
  onFaded: () => void;
  /** The box: the focused window's frame, or its group's. */
  rect: Rect;
  /** The focused window's restack shuffle, if any. */
  restack?: Restack | undefined;
  /** Eases the glow into a new box with its windows; see `useSettling`. */
  settler?: Settler | undefined;
  /** The windows inside the box. */
  windows: readonly string[];
};

/**
 * An accent ring and glow around the window or group commands target.
 *
 * - An outer `box-shadow` only, which is never drawn under its own box, so it
 *   lights the gaps around the box and leaves the client's pixels untouched.
 *   Inside a group it does not light the gaps between the windows.
 * - It sits at the windows' depth before every window in the document, so
 *   windows at that depth cover it and windows above it stay above.
 * - It fades in and out in place instead of moving to the next box.
 * - It plays the focused window's motion, moves with its windows, and takes
 *   no pointer events.
 */
export const FocusGlow = ({
  depth,
  dragging,
  leaving,
  motion,
  onFaded,
  rect,
  restack,
  settler,
  windows,
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
        glowStyles,
        fadeStyles({ leaving }),
        movingStyles({ motion }),
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      data-focus-box={windows.join(" ")}
      data-leaving={leaving || undefined}
      onTransitionEnd={(event) => {
        if (event.propertyName === "opacity") {
          onFaded();
        }
      }}
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
 * Rounded like a window's frame.
 *
 * - Dark: a 1px ring, like a window's edge, and a wide glow.
 * - Light: a translucent glow barely shows on a light wallpaper, so a solid
 *   ring with a pale outer band, which reads on light and dark parts of the
 *   photo alike.
 */
const glowStyles = css({
  borderRadius: "lg",
  boxShadow: {
    _light:
      "0 0 0 {spacing.0.75} {colors.accent}, 0 0 0 {spacing.1.25} color-mix(in oklab, {colors.accent} 35%, {colors.background}), 0 0 {spacing.6} {spacing.1.5} color-mix(in oklab, {colors.accent} 50%, transparent), {shadows.lifted}",
    base: "0 0 0 1px color-mix(in oklab, {colors.accent} 70%, transparent), 0 0 {spacing.9} color-mix(in oklab, {colors.accent} 45%, transparent), {shadows.lifted}",
  },
  pointerEvents: "none",
});

/** Eased by `settlingStyles`, which carries the `opacity` transition. */
const fadeStyles = cva({
  base: { _starting: { opacity: 0 } },
  variants: {
    leaving: {
      false: { opacity: 1 },
      true: { opacity: 0 },
    },
  },
});
