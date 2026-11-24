import type { PointerEvent as ReactPointerEvent } from "react";

import type { Float } from "./floating/float";
import type { FloatDrag } from "./floating/useFloatDrag";
import { useFloatDrag } from "./floating/useFloatDrag";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { TitleBar } from "./TitleBar";
import type { Aim, DropTargets } from "./tiled/aim";
import { tabAimAt } from "./tiled/aim";
import type { TileDrag } from "./tiled/useTileDrag";
import { useTileDrag } from "./tiled/useTileDrag";
import type { TitleFocus } from "./title-focus";
import type { StripPlace, TabLayout } from "./tree/frames";
import { windowsIn } from "./tree/node";
import type { WindowMotion } from "./window-motion";

/** The primary button, as `PointerEvent.button` numbers it. */
const PRIMARY_BUTTON = 0;

type Props = {
  /** Whether the window just moved to another group. See {@link TitleBar}. */
  crossing?: boolean | undefined;
  /** The stacking depth of the window it names. */
  depth: number;
  /** The page's description. See {@link TitleBar}. */
  description?: string | undefined;
  /** Whether this window is being dragged. See {@link TitleBar}. */
  dragging: boolean;
  /** The window's float, or `undefined` while it is tiled. */
  float: Float | undefined;
  /** The bar's focus state. See `title-focus.ts`. */
  focus: TitleFocus;
  /** The window's whole box. See {@link TitleBar}. */
  frame: Rect;
  /** Whether the window is fullscreen. See {@link TitleBar}. */
  fullscreen: boolean;
  /** The window's icon URL. See {@link TitleBar}. */
  icon?: string | undefined;
  /** The color marking the window's icon. See {@link TitleBar}. */
  mark?: string | undefined;
  /** The window's motion, which the bar plays too. */
  motion: WindowMotion;
  /** Where a dragged tiled window would land if dropped now. */
  onAim: (aim: Aim | undefined) => void;
  onClose: () => void;
  onDrop: () => void;
  /** A tiled window dropped where it was aimed. See `useTileDrag`. */
  onDropOn: (aim: Aim) => void;
  onFloat: () => void;
  onFullscreen: () => void;
  onMotionEnded: () => void;
  onGrab: () => void;
  onMove: (x: number, y: number) => void;
  /** A move of the window was pulled. See `useTileDrag`. */
  onPull: () => void;
  /**
   * Where the bar is drawn. Taken from the placement, not the float, which a
   * fullscreen window does not use.
   */
  rect: Rect;
  /** The window's restack animation, which the bar plays too. */
  restack?: Restack | undefined;
  /** The tab strip direction. See {@link TitleBar}. */
  /** Its place in its tab strip. See {@link TitleBar}. */
  strip: StripPlace | undefined;
  tabbed: TabLayout | undefined;
  /** What a tiled window can be dropped on, on every screen. */
  targets: DropTargets;
  title: string;
  /** The window this bar names. See {@link TitleBar}. */
  window: string;
};

/**
 * A window's title bar, for both tiled and floating windows.
 *
 * One component for both, so toggling floating does not remount the bar and
 * make it jump while the contents ease to the new box.
 *
 * A lone floating window's bar drags it without the modifier, and lets it go
 * beside a tab it is over; a bar never resizes. A tiled window's bar or tab,
 * and a tab of a floating group of several, drags like a modifier drag
 * (`useTileDrag`), with the primary button only, onto any screen. A middle
 * click closes the window. A fullscreen window's bar does not drag.
 */
export const WindowTitleBar = ({
  crossing,
  depth,
  description,
  dragging,
  float,
  focus,
  frame,
  fullscreen,
  icon,
  mark,
  motion,
  onAim,
  onClose,
  onDrop,
  onDropOn,
  onFloat,
  onFullscreen,
  onGrab,
  onMotionEnded,
  onMove,
  onPull,
  rect,
  restack,
  strip,
  tabbed,
  targets,
  title,
  window,
}: Props) => {
  const alone = { node: { id: window, up: 0 }, windows: [window] };
  // Both hooks run for every bar, since hooks cannot be conditional.
  const floatDrag = useFloatDrag({
    aimer: {
      at: (x, y) => tabAimAt(targets, alone, x, y),
      onAim,
      onDropOn,
    },
    float,
    onDrop,
    onGrab,
    onMove,
    onPull,
    onResize: doesNotResize,
    resizes: false,
  });
  const tileDrag = useTileDrag({
    dragged: alone,
    frame,
    onAim,
    onDrop,
    onDropOn,
    onGrab,
    onPull,
    onStretch: doesNotStretch,
    resizes: false,
    targets,
  });
  return (
    <TitleBar
      crossing={crossing}
      depth={depth}
      description={description}
      dragging={dragging}
      floating={float !== undefined}
      focus={focus}
      frame={frame}
      fullscreen={fullscreen}
      // Only one of the two drags runs at a time.
      grabbing={
        floatDrag.drag?.pulled === true || tileDrag.drag?.pulled === true
      }
      hanging={float?.scratchpad === true}
      icon={icon}
      mark={mark}
      motion={motion}
      onClose={onClose}
      onFloat={onFloat}
      onFullscreen={onFullscreen}
      onMiddleClick={onClose}
      onMotionEnded={onMotionEnded}
      rect={rect}
      restack={restack}
      strip={strip}
      tabbed={tabbed}
      title={title}
      window={window}
      {...dragOf(float, fullscreen, floatDrag, tileDrag, strip !== undefined)}
    />
  );
};

/** Never called: a bar does not resize. */
const doesNotResize = () => {
  throw new Error("window title bar: a bar does not resize its window");
};

/** Never called: a tiled window's bar only moves it. */
const doesNotStretch = () => {
  throw new Error("window title bar: a bar does not resize its window");
};

/**
 * The drag handlers for a bar: a lone float's, which moves it; a tiled
 * window's or a tab pulled out of a floating group (primary button only); or
 * none for a fullscreen window.
 *
 * As in a browser, a tab of a floating group of several moves only itself, and
 * the strip's empty end moves the group (see `StripEnd`).
 */
const dragOf = (
  float: Float | undefined,
  fullscreen: boolean,
  { drag: _floatDrag, ...floatHandlers }: FloatDrag,
  tileDrag: TileDrag,
  isTab: boolean,
): {
  onContextMenu?: (event: { preventDefault: () => void }) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
} => {
  if (float !== undefined && !(isTab && windowsIn(float.root).length > 1)) {
    return floatHandlers;
  } else if (fullscreen) {
    return {};
  } else {
    return {
      onPointerDown: (event) => {
        if (event.button === PRIMARY_BUTTON) {
          tileDrag.onPointerDown(event);
        }
      },
    };
  }
};
