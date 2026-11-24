import type { CSSProperties } from "react";

import { cva } from "../../styled-system/css";
import type { Rect } from "../rect";
import type { Seen } from "./sight";
import { matrixOf } from "./tiles";

/**
 * The box inside each part of a window's wrapper that the overview moves: by
 * one camera on its screen, which pulls back from the shown workspace as the
 * overview opens and pushes back in as it closes. Leaving, a hidden
 * workspace's windows also fade.
 *
 * Its own box, inside the wrapper that clips it (see {@link seenClip}): a
 * transformed element's `clip` moves with it, and would let a window drawn
 * beside the shown workspace show on the next monitor.
 *
 * A transition, not an animation, so closing partway through opening turns
 * back from wherever the camera has got to. The move is set through
 * `--overview-to`, since `@starting-style` loses to an inline `transform`.
 *
 * `emphasized`, as a workspace switch: the move is up to a screen's size.
 */
export const seenStyles = cva({
  base: {
    // Custom properties are inherited, so setting the move as the overview
    // opens or closes would restyle every element in the window. Reset under
    // the box, the window's parts keep their style and the restyle stops
    // there. Not by `@property`: registering any slows every restyle.
    "& > *": { "--overview-from": "initial", "--overview-to": "initial" },
    insetBlockStart: 0,
    insetInlineStart: 0,
    position: "absolute",
    transform: "var(--overview-to, none)",
    transformOrigin: "0 0",
  },
  variants: {
    // Coming into view from where it sat beside the shown workspace,
    // `--overview-from`. A starting style applies only as an element comes
    // into view, so a window already showing that moves to another tile
    // eases there from its own.
    arriving: {
      false: {},
      true: { _starting: { transform: "var(--overview-from)" } },
    },
    // Out of view, as its parts are, so it comes into view with them and
    // takes its starting style. See `arriving`.
    placed: {
      false: { display: "none" },
      true: {},
    },
    // In the overview, open or closing. Only then does it ease: once the
    // overview has closed, a box still easing to no transform would be a
    // stacking context of its own, and with its wrapper's depth gone (see
    // {@link seenClip}) a float would sink under the tiled windows until the
    // ease ended.
    seen: {
      false: {},
      true: {
        transition: `
          transform {durations.slower} {easings.emphasized},
          opacity {durations.slow} {easings.out}
        `,
      },
    },
    // A hidden workspace's window, which never takes the pointer: it is
    // under the picker, then leaving once the picker is gone. The tab strips
    // turn their own buttons' `pointer-events` back on, so this reaches every
    // part. Set from the start, not as the overview closes: changing it
    // restyles every element in the window.
    shut: {
      false: {},
      true: { "& *": { pointerEvents: "none!" }, pointerEvents: "none" },
    },
  },
});

/**
 * Inline style moving part of a window by `seen`, or none outside the
 * overview.
 *
 * Clipped to its `screen` as well, so a float hanging off the edge stays in
 * its tile: this clip moves with the box, the wrapper's (see
 * {@link seenClip}) does not.
 */
export const seenAt = (
  seen: Seen | undefined,
  screen: Rect | undefined,
): Record<`--${string}`, string> & CSSProperties => {
  if (seen === undefined || screen === undefined) {
    return {};
  } else {
    return {
      "--overview-to": matrixOf(seen.view),
      clip: screenRectOf(screen),
      opacity: seen.fading ? 0 : 1,
      ...(seen.arriving === undefined
        ? {}
        : { "--overview-from": matrixOf(seen.arriving) }),
    };
  }
};

/**
 * Inline style for the wrapper around {@link seenStyles}' box, clipping it to
 * its `screen` so a window coming in from beside the shown workspace stays on
 * its own monitor, or none outside the overview.
 *
 * The box inside is transformed, and so a stacking context, so the wrapper
 * takes the part's own `depth`: the parts still stack as they would at full
 * size.
 */
export const seenClip = (
  seen: Seen | undefined,
  screen: Rect | undefined,
  depth: number,
): CSSProperties => {
  if (seen === undefined || screen === undefined) {
    return {};
  } else {
    return { clip: screenRectOf(screen), zIndex: depth };
  }
};

/** `clip`'s rectangle for `screen`. */
const screenRectOf = (screen: Rect): string => {
  const top = `${screen.y.toString()}px`;
  const right = `${(screen.x + screen.width).toString()}px`;
  const bottom = `${(screen.y + screen.height).toString()}px`;
  const left = `${screen.x.toString()}px`;
  return `rect(${top}, ${right}, ${bottom}, ${left})`;
};
