import { AnimatedPlusIcon } from "@domicile-desktop/component-library/AnimatedPlusIcon";
import { Button } from "@domicile-desktop/component-library/Button";
import { useContext, useRef } from "react";

import { cva, cx } from "../styled-system/css";
import { flex } from "../styled-system/patterns";
import type { Float } from "./floating/float";
import type { Spot } from "./pointer-warp";
import type { Rect } from "./rect";
import { within } from "./rect";
import type { Restack } from "./restacking";
import { StripButtons } from "./StripButtons";
import { StripEnd } from "./StripEnd";
import { SlidingScreen } from "./sliding-screen";
import type { Aim, DropTargets } from "./tiled/aim";
import type { StripGroup } from "./tree/frames";
import { useLowered } from "./useLowered";
import type { Settler } from "./useSettling";
import { useSettling } from "./useSettling";
import type { WindowMotion } from "./window-motion";
import { barMotion, isLeaving, isMoving } from "./window-motion";
import {
  clickThroughStyles,
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
  /** The whole strip's box. See `StripPlace.box`. */
  box: Rect;
  /** The depth of its group, under the group's tabs by document order. */
  depth: number;
  /** Whether its group is being dragged, so the strip follows the pointer. */
  dragging: boolean;
  /** The strip's empty end, or `undefined` for a stack. */
  end: Rect | undefined;
  /** Whether a divider marks the end's start. See `StripPlace.endDivided`. */
  endDivided: boolean;
  /** The float holding the group, or `undefined` while it is tiled. */
  float: Float | undefined;
  /**
   * The open window's whole box, which the strip turns about with it. See
   * `scaledAbout`.
   */
  frame: Rect;
  /** Whether the group fills the screen. */
  fullscreen: boolean;
  group: StripGroup;
  /** The motion of the group's open window, which the strip plays too. */
  motion: WindowMotion;
  /**
   * Whether the strip sits in another group's well. See `StripPlace.nested`.
   */
  nested: boolean;
  /** Where the group would land if dropped now. See `StripEnd`. */
  onAim: (aim: Aim | undefined) => void;
  onDrop: () => void;
  /** The group dropped where it was aimed. See `StripEnd`. */
  onDropOn: (aim: Aim) => void;
  /** Floats or tiles the whole group. */
  onFloat: () => void;
  /** Fills the screen with the whole group, or gives it back. */
  onFullscreen: () => void;
  /** The group taken hold of by the strip's end. */
  onGrab: () => void;
  /**
   * Called when the pointer enters any part of the strip, with the page
   * position. Focus follows the cursor onto the group. See `WindowFrame`.
   */
  onHover: (at: Spot) => void;
  /** A floating group's new top-left corner. */
  onMove: (x: number, y: number) => void;
  /** A move of the group was pulled. See `StripEnd`. */
  onPull: () => void;
  /** Opens a tab past the last one. */
  onNewTab: () => void;
  /** The open window's restack animation, which the strip plays too. */
  restack?: Restack | undefined;
  /** Eases the strip into a new box; see `useSettling`. */
  settler?: Settler | undefined;
  /** What a tiled group can be dropped on, on every screen. */
  targets: DropTargets;
};

/**
 * The tab strip of a tabbed or stacking group: one box behind every tab in
 * it, with the strip's edges, and its end's new-tab button, group buttons and
 * drag handle.
 *
 * Its tabs are drawn over it, each by its own window (see `TitleBar`), so a
 * tab keeps its element when it moves to another strip. The strip is drawn by
 * the group's open window, and moves and settles with it. A tab switch hands
 * it to the next open window, which takes over where it is drawn (see
 * `useSettling`).
 *
 * A window moved into or out of a nested group draws a strip at another depth
 * next, and a window joining another group draws that group's strip. Each is
 * a new strip, which takes over from the one there before.
 */
export const TabStrip = (props: Props) => (
  <PlacedStrip key={placeKeyOf(props.group)} {...props} />
);

/**
 * Tells apart the strips a window draws: one per depth and set of windows, so
 * a strip moved with its group keeps its element.
 */
const placeKeyOf = ({ wells, windows }: StripGroup): string =>
  `${wells.toString()}:${windows.toSorted().join()}`;

/** The strip {@link TabStrip} draws at one depth. */
const PlacedStrip = ({
  box,
  depth,
  dragging,
  end,
  endDivided,
  float,
  frame,
  fullscreen,
  group,
  motion,
  nested,
  onAim,
  onDrop,
  onDropOn,
  onFloat,
  onFullscreen,
  onGrab,
  onHover,
  onMove,
  onNewTab,
  onPull,
  restack,
  settler,
  targets,
}: Props) => {
  const element = useRef<HTMLDivElement>(null);
  const origin = originOf(frame, box);
  const leaving = isLeaving(motion);
  const playing = stripMotion(motion);
  const lowered = useLowered(depth);
  const sliding = useContext(SlidingScreen);
  useSettling({
    element,
    origin,
    rect: box,
    settler,
    shared: sharedKeysOf(group),
    still: dragging || isMoving(playing),
  });
  return (
    <div
      className={cx(
        stripStyles({ nested }),
        movingStyles({ motion: playing }),
        leaving && clickThroughStyles,
        settlingStyles({ lowered }),
        dragging && heldStyles,
      )}
      data-motion={motion}
      data-strip
      // A leaving group's buttons would do nothing.
      inert={leaving}
      // `pointerover` bubbles from whichever part the pointer entered.
      onPointerOver={(event) => {
        onHover([event.clientX, event.clientY]);
      }}
      ref={element}
      style={{
        ...placedAt(box, depth),
        ...clippedAlong(sliding, box),
        ...scaledAbout(frame, box),
        ...shuffledBy(restack),
      }}
    >
      {end !== undefined && (
        <>
          <StripEnd
            float={float}
            fullscreen={fullscreen}
            group={group}
            onAim={onAim}
            onDrop={onDrop}
            onDropOn={onDropOn}
            onGrab={onGrab}
            onMove={onMove}
            onPull={onPull}
            rect={within(end, box)}
            targets={targets}
          />
          <NewTab
            at={within(end, box)}
            divided={endDivided}
            onNewTab={onNewTab}
            settler={settler}
          />
          <StripButtons
            floating={float !== undefined}
            fullscreen={fullscreen}
            onFloat={onFloat}
            onFullscreen={onFullscreen}
            rect={within(end, box)}
          />
        </>
      )}
    </div>
  );
};

/**
 * The motion the strip plays for its open window's `motion`. A new tab opens
 * out on the strip, and a tab switch only fades the windows; the strip stays.
 */
const stripMotion = (motion: WindowMotion): WindowMotion =>
  motion === "opening-tab" ? "resting" : barMotion(motion);

/**
 * The keys a strip shares with the windows in it, its own window's last: a
 * strip its window just joined takes over from that group's strip, not from
 * the one its window left.
 */
const sharedKeysOf = (group: StripGroup): readonly string[] =>
  [
    ...group.windows.filter((window) => window !== group.node.id),
    group.node.id,
  ].map((window) => stripKeyOf(group, window));

/**
 * The key a strip shares with every window in it, so the strip drawn by a
 * newly open tab takes over from the one before. Keyed by depth too, so a
 * nested group's strip does not take over from the one around it.
 */
const stripKeyOf = ({ wells }: StripGroup, window: string): string =>
  `strip:${wells.toString()}:${window}`;

/**
 * The new-tab button at the start of the strip's end, `at`. It eases along the
 * strip as tabs open and close before it, as the tabs do. A divided button
 * draws a divider before it, as a hidden tab does (see `TitleBar`).
 */
const NewTab = ({
  at,
  divided,
  onNewTab,
  settler,
}: {
  at: Rect;
  divided: boolean;
  onNewTab: () => void;
  settler: Settler | undefined;
}) => {
  const element = useRef<HTMLSpanElement>(null);
  // A point: the button keeps its size.
  const point = { height: 1, width: 1, x: at.x, y: at.y };
  useSettling({ element, origin: CORNER, rect: point, settler, still: false });
  return (
    // A press here must not drag the group.
    <span
      className={newTabStyles}
      data-divided={divided || undefined}
      data-new-tab
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      ref={element}
      style={{ insetInlineStart: `${at.x.toString()}px` }}
    >
      <Button label="New tab" onClick={onNewTab} size="xs" variant="ghost">
        <AnimatedPlusIcon size={12} />
      </Button>
    </span>
  );
};

const CORNER = { x: 0, y: 0 };

/**
 * The strip: a rounded top, an edge all round, and a bottom edge that is the
 * window's top edge. The window's top row is tucked under the strip's bottom
 * row (see `SURFACE_TUCK`), and the open tab covers that row to join its
 * window.
 */
const stripStyles = cva({
  base: {
    backgroundColor: "tabRail",
    // Longhands, as for `edgeStyles`.
    borderBlockEndWidth: "1px",
    borderBlockStartWidth: "1px",
    borderColor: "var(--strip-edge)",
    borderInlineWidth: "1px",
    borderStartEndRadius: "lg",
    borderStartStartRadius: "lg",
    borderStyle: "solid",
  },
  variants: {
    nested: {
      false: { "--strip-edge": "{colors.borderStrong}" },
      // On a well, as light as the open tab, the usual edge fades into it.
      // See `GroupWell`.
      true: {
        "--strip-edge":
          "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
      },
    },
  },
});

/**
 * Level with the tabs, which sit below the strip's top inset, and centered as
 * `StripButtons` centers the group buttons. A divided button's divider matches
 * a hidden tab's, at the same height on the strip.
 */
const newTabStyles = flex({
  "&[data-divided]::before": {
    backgroundColor: "borderStrong",
    content: '""',
    inlineSize: "1px",
    insetBlockEnd: 1,
    insetBlockStart: "calc({spacing.1} + 1px)",
    insetInlineStart: 0.5,
    position: "absolute",
  },
  align: "center",
  insetBlockEnd: "1px",
  insetBlockStart: 1,
  paddingInlineStart: 1,
  pointerEvents: "auto",
  position: "absolute",
});
