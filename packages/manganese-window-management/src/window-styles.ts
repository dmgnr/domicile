import type { CSSProperties } from "react";

import { css, cva } from "../styled-system/css";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import type { Point } from "./settle";
import type { TabLayout } from "./tree/frames";
import { Layout } from "./tree/node";
import type { WindowMotion } from "./window-motion";
import { isScratchpadSlide, isSwitching } from "./window-motion";

/**
 * Styles shared by every window.
 *
 * No background: a client surface's element is a hole the compositor draws
 * into, and a background would cover it.
 *
 * No `display`: atomic classes tie on specificity, so this would race the
 * window's own `display`. Fixed positioning already blockifies the box.
 */
export const windowStyles = css({
  // Outranks a window's own `display`, which would beat the UA `hidden` rule.
  "&[hidden]": { display: "none" },
});

/**
 * Inline style placing part of a window at `rect` and stacking it at `depth`.
 *
 * Inline because Panda only extracts build-time literals. `depth` must be the
 * element's own `z-index`, since that is what stacks the client's surface.
 * Coordinates are the desktop's: the viewport spans every display.
 *
 * Absolute, not fixed, so a window's wrapper can clip it to its screen (see
 * {@link clippedTo}). The wrapper sits at the desktop's corner and has no
 * `z-index`, so the coordinates and stacking are those of the page.
 */
export const placedAt = (rect: Rect, depth: number): CSSProperties => ({
  blockSize: `${rect.height.toString()}px`,
  inlineSize: `${rect.width.toString()}px`,
  insetBlockStart: `${rect.y.toString()}px`,
  insetInlineStart: `${rect.x.toString()}px`,
  position: "absolute",
  zIndex: depth,
});

/**
 * Inline style keeping a window's contents as big as the box it is drawn at
 * while it settles from `from` into `rect`, on each side where `from` is
 * bigger. A shrinking box crops its contents rather than showing a gap
 * inside them; they take their new size when the settle ends.
 */
export const keptAt = (from: Rect | undefined, rect: Rect): CSSProperties =>
  from === undefined
    ? {}
    : {
        ...grownBy("blockSize", from.height - rect.height),
        ...grownBy("inlineSize", from.width - rect.width),
      };

/** `property` grown past the full size by `extra` pixels, if any. */
const grownBy = (
  property: "blockSize" | "inlineSize",
  extra: number,
): CSSProperties =>
  extra > 0
    ? { [property]: `calc(100% + ${Math.round(extra).toString()}px)` }
    : {};

/**
 * Inline style placing part of a window at `rect` inside the element that
 * holds it, such as a strip's end inside the strip. See {@link within}.
 */
export const placedIn = (rect: Rect): CSSProperties => ({
  blockSize: `${rect.height.toString()}px`,
  inlineSize: `${rect.width.toString()}px`,
  insetBlockStart: `${rect.y.toString()}px`,
  insetInlineStart: `${rect.x.toString()}px`,
  position: "absolute",
});

/**
 * The border that makes a window's edge visible. Focus is shown by `FocusGlow`,
 * not by this border's color.
 */
// Longhands, not `border`: the frame overrides one side, and a shorthand and
// longhand on one element race on Panda's emit order.
export const edgeStyles = css({
  borderColor: "borderStrong",
  borderStyle: "solid",
  borderWidth: "1px",
});

/**
 * Rounds a window's bottom corners; its bar rounds the top ones.
 *
 * Set on the `<app>` itself because `border-radius` on a layer also clips the
 * client's pixels. See `docs/architecture/WINDOW-COMPOSITING.md`.
 */
export const bottomCornerStyles = css({
  borderEndEndRadius: "lg",
  borderEndStartRadius: "lg",
});

/**
 * Lets the pointer pass through a window to the page, so the shell can handle
 * drags while the modifier is held.
 */
export const clickThroughStyles = css({ pointerEvents: "none" });

/**
 * Inline style setting part of a window's `transform-origin` to the center of
 * its whole `frame`.
 *
 * The bar and contents are separate elements; scaling both about one point
 * keeps them together. Pointer mapping is unaffected: the engine maps a
 * pointer through the `<app>`'s whole transform, origin included.
 */
export const scaledAbout = (frame: Rect, rect: Rect): CSSProperties =>
  originAt(originOf(frame, rect));

/**
 * Inline style setting a window's contents' `transform-origin`: the middle of
 * its whole `frame`, as {@link scaledAbout}, except for a tab opening or
 * closing. Its contents grow out of or shrink into its `tab` in the strip (see
 * `movingStyles`), so they are seen to come from or go to it.
 */
export const contentsScaledAbout = (
  motion: WindowMotion,
  frame: Rect,
  tab: Rect | undefined,
  rect: Rect,
): CSSProperties =>
  scaledAbout(
    (motion === "closing-tab" || motion === "opening-tab") && tab !== undefined
      ? tab
      : frame,
    rect,
  );

/** Inline style setting part of a window's `transform-origin` to `point`. */
export const originAt = ({ x, y }: Point): CSSProperties => ({
  transformOrigin: `${x.toString()}px ${y.toString()}px`,
});

/** The center of `frame`, from the corner of `rect`; see {@link scaledAbout}. */
export const originOf = (frame: Rect, rect: Rect): Point => ({
  x: frame.x + frame.width / 2 - rect.x,
  y: frame.y + frame.height / 2 - rect.y,
});

/**
 * Custom properties for the `windowRestacking` and `windowRestackingDepth`
 * keyframes, or none when the window is not restacking.
 *
 * The depths go through the animation so `z-index` changes when the windows
 * are furthest apart.
 */
export const shuffledBy = (
  restack: Restack | undefined,
): Record<`--${string}`, number | string> =>
  restack === undefined
    ? {}
    : {
        "--restack-from": restack.from,
        "--restack-to": restack.to,
        "--restack-x": `${restack.away.x.toString()}px`,
        "--restack-y": `${restack.away.y.toString()}px`,
      };

/**
 * Custom property for the `windowClosingTab` and `windowOpeningTab` keyframes:
 * which axis a tab collapses along. None for a bar that is not a tab.
 *
 * Set on the bar only; without it the keyframes just fade (see
 * `panda.config.ts`).
 */
export const collapsedAlong = (
  tabbed: TabLayout | undefined,
): Record<`--${string}`, number> => {
  switch (tabbed) {
    case Layout.Stacking: {
      return { "--collapse-y": 0 };
    }
    case Layout.Tabbed: {
      return { "--collapse-x": 0 };
    }
    case undefined: {
      return {};
    }
  }
};

/**
 * Custom property that starts a scratchpad slide, or the backdrop's fade with
 * it, `rewound` milliseconds in. See `DrawnWindow.rewound`.
 */
export const rewoundBy = (rewound: number): Record<`--${string}`, string> => ({
  "--motion-delay": `${(-rewound).toString()}ms`,
});

/**
 * Custom properties for the keyframes that slide a window off its `screen`,
 * set on a wrapper and inherited by each part of the window:
 *
 * - `--workspace-width`: the screen width, so the two workspaces of a switch
 *   stay side by side.
 * - `--lift`: how far up `frame` must move to clear the screen's top edge, for
 *   the scratchpad's slides. Only while `motion` is one: a float being dragged
 *   would change it every frame, and that repaints every part of the window.
 * - `--motion-delay`: see {@link rewoundBy}.
 */
export const slidAcross = (
  screen: Rect,
  frame: Rect | undefined,
  motion: WindowMotion,
  rewound: number,
): Record<`--${string}`, string> => ({
  ...rewoundBy(rewound),
  "--workspace-width": `${screen.width.toString()}px`,
  ...(frame === undefined || !isScratchpadSlide(motion)
    ? {}
    : { "--lift": `${(frame.y + frame.height - screen.y).toString()}px` }),
});

/**
 * Custom property taking the ring and shadow off a moving tab's contents (see
 * `movingStyles`) when its window fills its screen, where the shadow would
 * spill onto the next display. None otherwise, so the keyframes' own applies.
 */
export const unedgedOn = (
  fillsScreen: boolean,
): Record<`--${string}`, string> =>
  fillsScreen ? { "--tab-edge": "none" } : {};

/**
 * The wrapper around each part of a window that clips it to its screen; see
 * {@link clippedTo}.
 *
 * A box, since `clip` needs one, but an empty one at the desktop's corner: its
 * parts are positioned, so it takes no space and no pointer. Without a
 * `z-index` it is no stacking context, so each part still stacks by its own.
 */
export const screenClipStyles = css({
  insetBlockStart: 0,
  insetInlineStart: 0,
  position: "absolute",
});

/**
 * Inline style clipping a window's wrapper to its `screen` while a workspace
 * switch slides it, or none.
 *
 * The page spans every monitor, so a window sliding off its screen would show
 * on the next one. `clip` is a plain rectangle, like the notification drawer's
 * `overflow: clip`, so the compositor applies it to client surfaces too and the
 * slide stays on the compositor thread. None at rest: a float being dragged
 * draws across both screens.
 */
export const clippedTo = (
  screen: Rect,
  motion: WindowMotion,
): CSSProperties => {
  if (isSwitching(motion)) {
    const top = `${screen.y.toString()}px`;
    const right = `${(screen.x + screen.width).toString()}px`;
    const bottom = `${(screen.y + screen.height).toString()}px`;
    const left = `${screen.x.toString()}px`;
    return { clip: `rect(${top}, ${right}, ${bottom}, ${left})` };
  } else {
    return {};
  }
};

/**
 * The screen a workspace switch slides a window across, or `undefined` when
 * no switch is sliding it. See {@link clippedAlong}.
 */
export const slidingAcross = (
  screen: Rect,
  motion: WindowMotion,
): Rect | undefined => (isSwitching(motion) ? screen : undefined);

/**
 * Inline style clipping part of a window at `rect` to the `screen` a switch
 * slides it across (see {@link slidingAcross}), or none.
 *
 * In the part's own box, so the clip moves with the slide: a float hanging
 * off the screen's edge stays off its workspace instead of sliding into view
 * beside it. {@link clippedTo}'s clip stays put, keeping the slide on its
 * monitor.
 */
export const clippedAlong = (
  screen: Rect | undefined,
  rect: Rect,
): CSSProperties => {
  if (screen === undefined) {
    return {};
  } else {
    const top = `${(screen.y - rect.y).toString()}px`;
    const right = `${(screen.x + screen.width - rect.x).toString()}px`;
    const bottom = `${(screen.y + screen.height - rect.y).toString()}px`;
    const left = `${(screen.x - rect.x).toString()}px`;
    return { clip: `rect(${top}, ${right}, ${bottom}, ${left})` };
  }
};

/**
 * A window's animation, keyed by `WindowMotion`. Keyframes are in
 * `panda.config.ts`.
 *
 * All are transforms and opacity, so the client never redraws. A motion that
 * also holds or swaps depth does so in a second animation, so the compositor
 * thread can still run the first. Opening and
 * closing use `durations.fast` to match {@link settlingStyles}, so a window
 * and its neighbors move together. Both use `outQuart`, front-loading the
 * motion; an ease-in close at this length looks like the window sits still,
 * then vanishes. Departures use `forwards` so the window does not snap back
 * before it is removed.
 */
export const movingStyles = cva({
  compoundVariants: [
    {
      contents: true,
      css: {
        animationDelay: "token(durations.fastest)",
        animationFillMode: "both",
      },
      motion: ["closing-tab", "uncovering"],
    },
    // A closing tab's contents shrink into its tab and fade, over the tab
    // they uncover; a new tab's grow out of it over the tab they hide (see
    // `contentsScaledAbout`). A fade alone, over the same box, reads as a tab
    // switch. Slower than a window's, so the move to the strip is seen.
    //
    // Their edge scales with them, too thin to show them over a like tab (a
    // terminal over a terminal), so they also carry a ring and shadow
    // (`windowOpeningTabEdge`, `windowClosingTabEdge`). A second animation,
    // since `box-shadow` cannot run on the compositor thread.
    {
      contents: true,
      css: {
        animationDuration: "token(durations.slow)",
        animationName: "windowClosingIntoTab, windowClosingTabEdge",
        animationTimingFunction: "token(easings.outQuart)",
      },
      motion: "closing-tab",
    },
    {
      contents: true,
      css: {
        animationDuration: "token(durations.slow)",
        animationName: "windowOpeningFromTab, windowOpeningTabEdge",
        animationTimingFunction: "token(easings.outQuart)",
      },
      motion: "opening-tab",
    },
  ],
  variants: {
    /**
     * Whether this is the window's contents, rather than its bar or glow.
     *
     * The tab a close or send uncovers was not drawn while hidden, and an
     * `<app>` drawn anew takes a frame or two to show. The leaving tab's
     * contents wait that long before fading, so the desktop does not show
     * through. A closing tab's bar collapses at once, with its neighbors, and
     * the window is done when its contents are (see `useWindowMotion`). A
     * sent tab's bar waits with its contents (see `sending-tab`).
     */
    contents: { false: {}, true: {} },
    motion: {
      // Both workspaces share timing so they stay side by side. `emphasized`,
      // not `outQuart`: a full-screen slide that starts at full speed jumps.
      // A part first drawn partway through starts where the others have got
      // to (`--motion-delay`, see `DrawnWindow.shownRewound`).
      "arriving-from-end": {
        animation:
          "windowArrivingFromEnd {durations.slower} {easings.emphasized} var(--motion-delay, 0ms)",
      },
      "arriving-from-start": {
        animation:
          "windowArrivingFromStart {durations.slower} {easings.emphasized} var(--motion-delay, 0ms)",
      },
      closing: {
        animation: "windowClosing {durations.fast} {easings.outQuart} forwards",
      },
      // Same curve as {@link settlingStyles}, so neighboring tabs move with it.
      "closing-tab": {
        animation: "windowClosingTab {durations.fast} {easings.out} forwards",
      },
      // The tab being hidden. Lasts as long as a new tab's contents, the
      // longest that draws over it, so it stays under them.
      concealing: {
        animation: "windowConcealing {durations.slow} {easings.in-out}",
      },
      // The scratchpad's slides avoid front-loaded curves, so a slide of up
      // to a screen's height is seen: `out` settles the window into place.
      // Stowing plays the drop backwards, so its exit starts where it can be
      // seen, and either can take over from the other where it was cut short
      // (`--motion-delay`, see `slidAcross`).
      dropping: {
        animation:
          "windowDropping {durations.slow} {easings.out} var(--motion-delay, 0ms)",
      },
      "leaving-to-end": {
        animation:
          "windowLeavingToEnd {durations.slower} {easings.emphasized} forwards",
      },
      "leaving-to-start": {
        animation:
          "windowLeavingToStart {durations.slower} {easings.emphasized} forwards",
      },
      opening: {
        animation: "windowOpening {durations.fast} {easings.outQuart}",
      },
      // The reverse of `closing-tab`, on the same curve as its neighbors.
      "opening-tab": {
        animation: "windowOpeningTab {durations.fast} {easings.out}",
      },
      // Overlapping floats separate, swap depths, and rejoin. Parameters come
      // from {@link shuffledBy}. `in-out` pauses them where they swap.
      restacking: {
        animation:
          "windowRestacking {durations.slower} {easings.in-out}, windowRestackingDepth {durations.slower} {easings.in-out}",
      },
      // A second name so an immediate repeat restarts the animation.
      "restacking-again": {
        animation:
          "windowRestackingAgain {durations.slower} {easings.in-out}, windowRestackingDepthAgain {durations.slower} {easings.in-out}",
      },
      resting: {},
      // Fades in over the hidden tab in the same box, giving a crossfade.
      revealing: {
        animation:
          "windowRevealing {durations.fast} {easings.in-out}, windowHeldTiled {durations.fast} {easings.in-out}",
      },
      // Slower than `closing` and on an even curve, so the window is seen
      // leaving rather than vanishing. It draws over the windows moving into
      // its space, so it need not keep pace with them.
      sending: {
        animation: "windowSending {durations.slow} {easings.in-out} forwards",
      },
      // A tab leaves its strip as a sent window leaves, so it does not look
      // closed. Bar and contents wait together for the tab it uncovers (see
      // `contents`), since both scale about one point.
      "sending-tab": {
        animation:
          "windowSending {durations.slow} {easings.in-out} {durations.fastest} both",
      },
      stowing: {
        animation:
          "windowStowing {durations.slow} {easings.out} var(--motion-delay, 0ms) reverse forwards",
      },
      // Lasts as long as a closing tab's contents, which it is drawn under.
      uncovering: {
        animation: "windowHeldTiled {durations.slow} {easings.out}",
      },
    },
  },
});

/**
 * Puts a part of a window being dragged or resized on a layer of its own, so
 * moving it moves the layer and repaints nothing.
 *
 * Without it, Chromium squashes the parts over an `<app>` into shared layers
 * and repaints them, blurred shadows and glows included, on every pointer
 * move. Only while held: each layer costs memory.
 */
export const heldStyles = css({ willChange: "transform" });

/**
 * Transitions for what a part of a window changes in place. Its box moves
 * with `useSettling` instead, on the compositor's thread, so every part keeps
 * with its client's contents.
 *
 * - Depth: never eased, since each `z-index` step restacks the page's
 *   layers. A raise is at once. A part whose depth dropped (`lowered`, see
 *   `useLowered`) keeps its old depth until it has settled, so a window
 *   leaving fullscreen stays above the windows it still covers (see
 *   `placement.ts`).
 * - Colors: focus follows the pointer, so snapping would flicker.
 * - Opacity: so `FocusGlow` fades rather than blinks.
 *
 * One recipe because two rules setting `transition` on one element race on
 * Panda's emit order.
 */
export const settlingStyles = cva({
  defaultVariants: { lowered: false },
  variants: {
    lowered: {
      false: {
        transition:
          "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}, color {durations.fast} {easings.out}, opacity {durations.fast} {easings.out}",
      },
      true: {
        // main-thread animation: a lowered depth steps once at the end;
        // nothing eases.
        transition:
          "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}, color {durations.fast} {easings.out}, opacity {durations.fast} {easings.out}, z-index {durations.fast} step-end",
      },
    },
  },
});
