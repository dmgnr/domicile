import { AnimatedCloseIcon } from "@domicile-desktop/component-library/AnimatedCloseIcon";
import { AnimatedFloatIcon } from "@domicile-desktop/component-library/AnimatedFloatIcon";
import type { GroupLayout } from "@domicile-desktop/component-library/AnimatedLayoutIcon";
import { AnimatedLayoutIcon } from "@domicile-desktop/component-library/AnimatedLayoutIcon";
import { AnimatedMaximizeIcon } from "@domicile-desktop/component-library/AnimatedMaximizeIcon";
import { Button } from "@domicile-desktop/component-library/Button";
import { PopupBoundary } from "@domicile-desktop/component-library/PopupBoundary";
import { Tooltip } from "@domicile-desktop/component-library/Tooltip";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import type { ReactElement, PointerEvent as ReactPointerEvent } from "react";
import { useContext, useRef, useState } from "react";

import { css, cva, cx } from "../styled-system/css";
import { hstack, vstack } from "../styled-system/patterns";
import { grabCursorStyles } from "./grab-cursor-styles";
import { endsOwnAnimation } from "./own-animation";
import { CROSSING, raised } from "./placement";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { SlidingScreen } from "./sliding-screen";
import type { TitleFocus } from "./title-focus";
import type { StripPlace, TabLayout } from "./tree/frames";
import { Layout } from "./tree/node";
import { GrabCursor } from "./useGrabCursor";
import { useLowered } from "./useLowered";
import type { Settler } from "./useSettling";
import { UPRIGHT, useSettling } from "./useSettling";
import type { WindowMotion } from "./window-motion";
import { isLeaving, isMoving } from "./window-motion";
import {
  clickThroughStyles,
  clippedAlong,
  collapsedAlong,
  edgeStyles,
  heldStyles,
  movingStyles,
  originAt,
  originOf,
  placedAt,
  settlingStyles,
  shuffledBy,
} from "./window-styles";

/** The middle button, as `MouseEvent.button` numbers it. */
const MIDDLE_BUTTON = 1;

/** How a tab's group mark draws each layout. */
const GROUP_LAYOUTS: Record<Layout, GroupLayout> = {
  [Layout.SplitH]: "row",
  [Layout.SplitV]: "column",
  [Layout.Stacking]: "stack",
  [Layout.Tabbed]: "tabs",
};

/** What a tab's group mark calls each layout. */
const GROUP_NAMES: Record<Layout, string> = {
  [Layout.SplitH]: "Row",
  [Layout.SplitV]: "Column",
  [Layout.Stacking]: "Stack",
  [Layout.Tabbed]: "Tabs",
};

type Props = {
  /**
   * Whether its window just moved to another tab group, so it eases there
   * over the strips it passes. See `crossing.ts`.
   */
  crossing?: boolean | undefined;
  /** The stacking depth of the window it names. */
  depth: number;
  /**
   * The page's description, which a tab's tooltip shows under its title, or
   * `undefined` for none.
   */
  description?: string | undefined;
  /**
   * Whether the window is being dragged. Disables easing so the bar keeps up
   * with the pointer and its contents.
   */
  dragging: boolean;
  /** The bar's focus state. See `title-focus.ts`. */
  focus: TitleFocus;
  /** Whether a move of the window has been pulled. Shows `grabbing`. */
  grabbing?: boolean | undefined;
  /**
   * For a tab standing for a nested container, that container's layout and
   * the windows it holds.
   */
  group?: { layout: Layout; windows: readonly string[] } | undefined;
  /**
   * The window's whole box, which bar and contents both scale about. See
   * {@link scaledAbout}. For a tab, this is the tab's own box.
   */
  frame: Rect;
  /**
   * Whether the window hangs from the screen's top edge, as a scratchpad
   * window does, which squares the bar's top corners.
   */
  hanging?: boolean;
  /**
   * The window's icon URL, drawn before its title, or `undefined` for a
   * stand-in.
   */
  icon?: string | undefined;
  /**
   * A color for a dot on the icon's corner, or `undefined` for none: a
   * browser window's page's profile, when it is not the default one.
   */
  mark?: string | undefined;
  /** Whether the window floats. Switches the float button to "Tile". */
  floating: boolean;
  /**
   * Whether the window is fullscreen. Switches the button to "Restore" and
   * drops the bar's rounded corners and edge.
   */
  fullscreen: boolean;
  /**
   * The window's motion. The bar plays it too, so bar and contents move as
   * one.
   */
  motion: WindowMotion;
  /** Closes the window. */
  onClose: () => void;
  /** Toggles floating, like `floating toggle`. */
  onFloat: () => void;
  /** Toggles fullscreen, like `mod+f`. */
  onFullscreen: () => void;
  /** Called when `motion` finishes. */
  onMotionEnded: () => void;
  onContextMenu?: ((event: { preventDefault: () => void }) => void) | undefined;
  /** A middle click, which closes the window as a browser closes a tab. */
  onMiddleClick?: (() => void) | undefined;
  /** A press on the bar, which starts a drag or selects a tab's window. */
  onPointerDown?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  rect: Rect;
  /**
   * The restack animation while the window trades places with another float.
   * See `shuffledBy`.
   */
  restack?: Restack | undefined;
  /** Eases the bar into a new box; see `useSettling`. */
  settler?: Settler | undefined;
  /** Its place in its tab strip, or `undefined` for a window's own bar. */
  strip?: StripPlace | undefined;
  /**
   * The direction of the tab strip, which a closing tab collapses along. See
   * `collapsedAlong`. `undefined` for a window's own bar.
   */
  tabbed?: TabLayout | undefined;
  title: string;
  /** The window this bar names, which `AppWindow` reads on a press. */
  window: string;
};

/**
 * A window's title bar or container tab, with its title and controls.
 *
 * The bar is part of the window's box, not added to it. It is drawn at the
 * window's depth so windows in front cover it. The page hit-tests it, so
 * presses on it never reach the `<app>` below.
 *
 * A tab is drawn in its slot of its group's strip, over the strip itself
 * (`TabStrip`), so a tab keeps its element when it moves to another strip.
 * The open tab covers the strip's bottom edge to join its window.
 *
 * It moves as its window's contents do (`useSettling`), so the two keep
 * together.
 */
export const TitleBar = ({
  crossing = false,
  depth,
  description,
  dragging,
  floating,
  focus,
  frame,
  fullscreen,
  grabbing = false,
  group,
  hanging = false,
  icon,
  mark,
  motion,
  onClose,
  onContextMenu,
  onFloat,
  onFullscreen,
  onMiddleClick,
  onMotionEnded,
  onPointerDown,
  rect,
  restack,
  settler,
  strip,
  tabbed,
  title,
  window,
}: Props) => {
  const hidden = strip !== undefined && !strip.open;
  // A bar is raised unless it rests; a tab only while it is the open one.
  const lit = strip === undefined ? focus !== "resting" : !hidden;
  const fill = {
    hoverable: hidden,
    leaf: strip === undefined && focus === "leaf",
    lit,
  };
  // The open tab's edge follows its strip's: stronger on a well. See
  // `TabStrip`. A bar's own edge never changes, so it stays on the bar.
  const edge = strip === undefined ? "none" : edgeOf(strip);
  const element = useRef<HTMLDivElement>(null);
  // A tab opening or closing turns about its strip's start, as the tabs after
  // it ease along. Anything else turns about its whole window's middle.
  const origin = alongStrip(motion) ? STRIP_START : originOf(frame, rect);
  // Over the rest of the strip, which slides under it when tabs swap.
  const shownAt = (windowDepth: number) =>
    strip?.open === true ? raised(windowDepth) : windowDepth;
  const shownDepth = shownAt(depth);
  const lowered = useLowered(shownDepth);
  const sliding = useContext(SlidingScreen);
  useSettling({
    element,
    origin,
    // Over its window's contents.
    over: crossing ? shownAt(CROSSING) : undefined,
    rect,
    // A tab leaving its strip grows from the whole strip, over its contents,
    // so no part of the strip's row is left clear. A stack's bars already
    // span it.
    row: tabbed === Layout.Tabbed ? strip?.box : undefined,
    settler,
    shared: groupTabKeysOf(group, strip),
    still: dragging || isMoving(motion),
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a press only raises the window; its buttons are the keyboard-reachable controls
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same as above
    <div
      className={cx(
        slotStyles,
        strip !== undefined &&
          tabSlotStyles({ stacked: tabbed === Layout.Stacking }),
        movingStyles({ motion }),
        isLeaving(motion) && clickThroughStyles,
        settlingStyles({ lowered }),
        dragging && heldStyles,
        // The bar holds pointer capture during a drag, so its cursor shows.
        grabbing && grabCursorStyles[GrabCursor.Grabbing],
      )}
      data-divided={strip?.divided || undefined}
      // Exposed as attributes so devtools and tests can read the state.
      data-focus={focus}
      data-motion={motion}
      // A press here lands outside every `<app>`, so the window is named for
      // the focus handling in `AppWindow`.
      data-window={window}
      // A closed window's buttons would do nothing.
      inert={isLeaving(motion)}
      // Ignore animations bubbling up from the buttons, and the end of a motion
      // this one replaced.
      onAnimationEnd={(event) => {
        if (endsOwnAnimation(event)) {
          onMotionEnded();
        }
      }}
      onAuxClick={(event) => {
        if (event.button === MIDDLE_BUTTON) {
          onMiddleClick?.();
        }
      }}
      onContextMenu={onContextMenu}
      // A middle press closes the window, so it does not reach `WindowFrame`:
      // selecting a hidden tab would show it for an instant first.
      onPointerDown={(event) => {
        if (event.button === MIDDLE_BUTTON) {
          event.stopPropagation();
        } else {
          onPointerDown?.(event);
        }
      }}
      ref={element}
      style={{
        ...placedAt(rect, shownDepth),
        ...clippedAlong(sliding, rect),
        ...originAt(origin),
        ...shuffledBy(restack),
        ...collapsedAlong(tabbed),
      }}
    >
      <TabTooltip description={description} strip={strip} title={title}>
        <div
          className={cx(
            strip === undefined
              ? cx(
                  barStyles({ focus }),
                  !fullscreen && cx(edgeStyles, barEdgeStyles),
                  !fullscreen && !hanging && topCornerStyles,
                )
              : tabStyles({
                  focus,
                  joined: !hidden && tabbed === Layout.Tabbed,
                  nested: strip.nested,
                  open: !hidden,
                }),
          )}
          data-face
        >
          <Fill {...fill} edge={edge} />
          <span className={leadStyles} {...{ [UPRIGHT]: "" }}>
            {group !== undefined && (
              <GroupMark layout={group.layout} windows={group.windows.length} />
            )}
            {/* Keyed so a new icon gets another try after one fails to load. */}
            <WindowIcon icon={icon} key={icon} mark={mark} />
            <span
              className={titleStyles({ hoverable: fill.hoverable, lit })}
              data-title={title}
            >
              <span>{title}</span>
            </span>
          </span>
          {/*
        A press on a button must not start a drag: drag pointer capture would
        retarget the click to the bar.
      */}
          <span
            className={controlStyles}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            {...{ [UPRIGHT]: "" }}
          >
            <Fill {...fill} edge="none" inner />
            {/*
            A hidden tab only offers to close, as in a browser. A narrow bar
            drops these too. A tab shows its buttons only under the pointer or
            keyboard, so its title has the room the rest of the time.
          */}
            {!hidden && (
              <span
                className={cx(
                  extraControlStyles,
                  strip !== undefined && onHoverStyles,
                )}
              >
                <Button
                  label={floating ? "Tile" : "Float"}
                  onClick={onFloat}
                  size="sm"
                  variant="ghost"
                >
                  <AnimatedFloatIcon floating={floating} size={14} />
                </Button>
                <Button
                  label={fullscreen ? "Restore" : "Maximize"}
                  onClick={onFullscreen}
                  size="sm"
                  variant="ghost"
                >
                  <AnimatedMaximizeIcon maximized={fullscreen} size={14} />
                </Button>
              </span>
            )}
            <span className={cx(closeStyles, hidden && onHoverStyles)}>
              <Button label="Close" onClick={onClose} size="sm" variant="ghost">
                <AnimatedCloseIcon size={14} />
              </Button>
            </span>
          </span>
        </div>
      </TabTooltip>
    </div>
  );
};

/**
 * Shows a tab's whole title and its page's description while the pointer
 * rests on it, since a tab is cut to its slot. A window's own bar spans the
 * window, so it shows `children` alone.
 *
 * A tab is drawn outside its window's element, so it keeps its popups inside
 * its container itself.
 */
const TabTooltip = ({
  children,
  description,
  strip,
  title,
}: {
  children: ReactElement;
  description: string | undefined;
  strip: StripPlace | undefined;
  title: string;
}) =>
  strip === undefined ? (
    children
  ) : (
    <PopupBoundary box={strip.area}>
      <Tooltip
        content={
          <span className={summaryStyles}>
            <span className={summaryTitleStyles}>{title}</span>
            {description !== undefined && (
              <span className={summaryDescriptionStyles}>{description}</span>
            )}
          </span>
        }
        trigger={children}
      />
    </PopupBoundary>
  );

/** The open tab's edge in `strip`. */
const edgeOf = (strip: StripPlace): FillProps["edge"] =>
  strip.nested ? "nested" : "strong";

/** Whether a tab plays `motion` along its strip, opening or closing. */
const alongStrip = (motion: WindowMotion): boolean =>
  motion === "closing-tab" || motion === "opening-tab";

/** The `transform-origin` of a tab moving along its strip. */
const STRIP_START = { x: 0, y: 0 };

/**
 * The keys a group's tab shares with every window in the group, so a new
 * element drawing the tab, as when the window it is named after moves out,
 * takes over from the one before. Keyed by its strip's depth too, as
 * `TabStrip` keys a strip.
 */
const groupTabKeysOf = (
  group: Props["group"],
  strip: StripPlace | undefined,
): readonly string[] | undefined =>
  group === undefined || strip === undefined
    ? undefined
    : group.windows.map(
        (window) => `tab:${strip.group.wells.toString()}:${window}`,
      );

/**
 * The layout of the group a tab stands for, and its size, so a group in a tab
 * reads as a group rather than as the window it is named after.
 */
const GroupMark = ({
  layout,
  windows,
}: {
  layout: Layout;
  windows: number;
}) => (
  <span
    aria-label={`${GROUP_NAMES[layout]} of ${windows.toString()}`}
    className={groupMarkStyles}
    role="img"
  >
    <AnimatedLayoutIcon layout={GROUP_LAYOUTS[layout]} size={14} />
    {windows}
  </span>
);

/**
 * The window's icon, or a stand-in when it has none or it does not load, so
 * every title starts in the same place.
 */
const WindowIcon = ({
  icon,
  mark,
}: {
  icon: string | undefined;
  mark: string | undefined;
}) => {
  const [failed, setFailed] = useState(false);
  return (
    <span className={iconStyles} data-icon>
      {mark !== undefined && (
        <span
          className={markStyles}
          data-mark
          // Inline because the color is the config's, at runtime.
          style={{ backgroundColor: mark }}
        />
      )}
      {icon === undefined || failed ? (
        <AppWindowIcon size={16} />
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: `onError` is the image failing to load, not an interaction
        <img
          alt=""
          className={iconImageStyles}
          onError={() => {
            setFailed(true);
          }}
          src={icon}
        />
      )}
    </span>
  );
};

// Fills the slot with the bar's own box.
const slotStyles = css({ display: "flex" });

/**
 * A tab's slot in its strip, inside the strip's edges: its top row is the
 * strip's top edge and its bottom row the window's top edge. A divided slot
 * draws a divider before its tab.
 */
const tabSlotStyles = cva({
  base: {
    paddingBlockEnd: "1px",
    paddingBlockStart: "calc({spacing.1} + 1px)",
    paddingInlineStart: 1,
  },
  variants: {
    stacked: {
      // A short line in the gap before the tab, between two hidden tabs.
      false: {
        "&[data-divided]::before": {
          backgroundColor: "borderStrong",
          content: '""',
          inlineSize: "1px",
          // Centered on the tab's title.
          insetBlockEnd: 1.5,
          insetBlockStart: 2.5,
          insetInlineStart: 0.5,
          position: "absolute",
        },
      },
      // A stack's bars each span the strip, with a line between two.
      true: {
        "&[data-divided]::before": {
          backgroundColor: "borderStrong",
          blockSize: "1px",
          content: '""',
          insetBlockStart: 0,
          insetInlineEnd: 0,
          insetInlineStart: 0,
          position: "absolute",
        },
        paddingInlineEnd: 1,
      },
    },
  },
});

/** What a window's bar and a tab share. */
const faceStyles = {
  containerType: "inline-size",
  flex: 1,
  // See `fauxMedium`.
  fontWeight: "normal",
  gap: 1.5,
  // Over its `Fill`, which sits under everything else in it.
  isolation: "isolate",
  justify: "space-between",
  minInlineSize: 0,
  overflow: "hidden",
  position: "relative",
} as const;

type FillProps = {
  /** The raised layer's edge: a tab's, or none for a bar, which has its own. */
  edge: "nested" | "none" | "strong";
  /** A hidden tab, which lifts toward the open tab's color under the pointer. */
  hoverable: boolean;
  /** The buttons' own fill, inside the face's. See `fillStyles`. */
  inner?: boolean;
  /** The keyboard's own bar inside a selected group, washed in the accent. */
  leaf: boolean;
  /** Raised to the address bar's surface: an open tab, or a bar not resting. */
  lit: boolean;
};

/**
 * A bar's colors as layers stacked under its contents: the strip's own color,
 * always there, and over it the raised surface, the accent wash and a hidden
 * tab's hover. A change of state fades layers in and out with `opacity`
 * alone, which the compositor animates without painting the bar again, where
 * easing its `background-color` would paint it on every frame. Focus follows
 * the pointer, so these fades are frequent.
 *
 * The rest of the bar is clear, so its buttons carry their own, over the
 * title running under them as the bar settles.
 */
const Fill = ({ edge, hoverable, inner = false, leaf, lit }: FillProps) => (
  <>
    <span className={fillStyles({ inner, layer: "rail" })} data-fill="rail" />
    <span
      className={fillStyles({ edge, inner, layer: "raised", shown: lit })}
      data-fill="raised"
    />
    <span
      className={fillStyles({ inner, layer: "leaf", shown: leaf })}
      data-fill="leaf"
    />
    <span
      className={fillStyles({ hoverable, inner, layer: "hover", shown: false })}
      data-fill="hover"
    />
  </>
);

const fillStyles = cva({
  base: {
    borderRadius: "inherit",
    pointerEvents: "none",
    position: "absolute",
    transition: "opacity {durations.fast} {easings.out}",
    zIndex: -1,
  },
  /**
   * The buttons' fill only hides the title running under them. It keeps
   * clear of the open tab's edge, and each layer a pixel inside the one over
   * it: at a fractional scale a layer's edge pixels blend, and a layer's
   * edge under another's showed through as a seam round the buttons.
   */
  compoundVariants: [
    { css: { inset: "1px" }, inner: true, layer: ["hover", "leaf"] },
    { css: { inset: "2px" }, inner: true, layer: "raised" },
    { css: { inset: "3px" }, inner: true, layer: "rail" },
  ],
  defaultVariants: {
    edge: "none",
    hoverable: false,
    inner: false,
    shown: true,
  },
  variants: {
    edge: {
      nested: {
        borderBlockEndWidth: 0,
        borderBlockStartWidth: "1px",
        borderColor:
          "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
        borderInlineWidth: "1px",
        borderStyle: "solid",
      },
      none: {},
      strong: {
        borderBlockEndWidth: 0,
        borderBlockStartWidth: "1px",
        borderColor: "borderStrong",
        borderInlineWidth: "1px",
        borderStyle: "solid",
      },
    },
    hoverable: {
      false: {},
      true: { "[data-face]:hover &": { opacity: 1 } },
    },
    // The buttons' own fill, inset by `compoundVariants`.
    inner: { false: { inset: 0 }, true: {} },
    layer: {
      hover: {
        backgroundColor:
          "color-mix(in oklab, {colors.chrome} 60%, {colors.tabRail})",
      },
      leaf: {
        backgroundColor:
          "color-mix(in oklab, {colors.accent} 45%, {colors.chrome})",
      },
      // Opaque, not clear: a hidden tab broken out of its group grows into a
      // bar, and from clear the desktop would show through.
      rail: { backgroundColor: "tabRail" },
      // One surface with the address bar, which it meets. It stands out from
      // the strip's `tabRail`.
      raised: { backgroundColor: "chrome" },
    },
    shown: { false: { opacity: 0 }, true: { opacity: 1 } },
  },
});

/**
 * A heavier look for the title being worked in. A stroke under the glyphs
 * rather than a heavier weight, whose wider letters would shift the title
 * sideways as focus moves.
 */
const fauxMedium = {
  paintOrder: "stroke",
  WebkitTextStroke: "{borderWidths.fauxMedium} currentColor",
} as const;

/**
 * A tab, in its slot of the strip. The open tab is raised with an edge, and
 * covers the strip's bottom edge to meet its window. Hidden tabs lie flat on
 * the strip.
 */
const tabStyles = cva({
  base: hstack.raw({
    ...faceStyles,
    borderStartEndRadius: "md",
    borderStartStartRadius: "md",
    // Room for the open tab's edge, which its raised layer draws (see
    // `Fill`), so opening a tab moves nothing.
    paddingBlockStart: "1px",
    paddingInlineEnd: "calc({spacing.0.5} + 1px)",
    paddingInlineStart: "calc({spacing.2} + 1px)",
  }),
  variants: {
    // Weight as well as color, for users who cannot tell the colors apart.
    focus: {
      focused: fauxMedium,
      leaf: fauxMedium,
      resting: {},
      selected: {},
    },
    // Over the strip's bottom row, which draws the window's top edge. The
    // padding fills that row, so the title stays level with a hidden tab's.
    joined: {
      false: {},
      true: { marginBlockEnd: "-1px", paddingBlockEnd: "1px" },
    },
    nested: { false: {}, true: {} },
    open: {
      // A press opens a hidden tab.
      false: { cursor: "pointer" },
      true: {},
    },
  },
});

/**
 * A window's own bar, in sway's three client states plus `leaf`. Its colors
 * are `Fill`'s layers.
 */
const barStyles = cva({
  base: hstack.raw({
    ...faceStyles,
    // Just enough for the title to clear the rounded corner.
    paddingInlineEnd: 0.5,
    paddingInlineStart: 2,
  }),
  variants: {
    // Weight as well as color, for users who cannot tell the colors apart.
    focus: {
      focused: fauxMedium,
      leaf: fauxMedium,
      resting: {},
      selected: fauxMedium,
    },
  },
});

/**
 * No edge along the bottom, over the row of the window's surface tucked under
 * the bar (see `SURFACE_TUCK`), but padding in its place, so `Fill` covers
 * that row: a bar's layers fill only inside its edges.
 */
const barEdgeStyles = css({ borderBlockEndWidth: 0, paddingBlockEnd: "1px" });

/**
 * Rounds only the top corners. The contents round the bottom ones (see
 * `bottomCornerStyles`); a radius here would notch the seam.
 */
const topCornerStyles = css({
  borderStartEndRadius: "lg",
  borderStartStartRadius: "lg",
});

/**
 * No gap: each button is already padded, and together they read as a group.
 *
 * Kept upright about the bar's end while it settles, on the bar's own
 * background, so a title laid out wider than a growing bar runs under the
 * buttons.
 */
const controlStyles = hstack({
  // The tab's inside, not the buttons' height, which is a pixel taller.
  alignSelf: "stretch",
  gap: 0,
  // Over the title, with its own `Fill` beneath its buttons.
  isolation: "isolate",
  position: "relative",
  transformOrigin: "right center",
});

/**
 * The bar's group mark, icon and title, kept upright about the bar's start
 * while it settles. `transform-origin` has no logical keywords.
 */
const leadStyles = hstack({
  flex: 1,
  gap: 1.5,
  minInlineSize: 0,
  transformOrigin: "left center",
});

/**
 * Folded away until the pointer is on the tab or the keyboard is in it. Folded
 * to no width rather than hidden, so the keyboard still reaches the buttons.
 */
const onHoverStyles = css({
  "[data-face]:is(:hover, :focus-within) &": { maxInlineSize: "none" },
  maxInlineSize: 0,
  overflow: "hidden",
});

// A flex box rather than a line box, whose strut sat the close button above
// the bar's middle.
const closeStyles = css({ display: "flex" });

// Hidden in a bar too narrow to keep its title beside them. The bar is the
// query container (see `barStyles` and `tabStyles`).
const extraControlStyles = hstack({
  "@container (max-width: 10rem)": { display: "none" },
  gap: 0,
});

const groupMarkStyles = hstack({
  color: "muted",
  flexShrink: 0,
  // 13px, as for the title.
  fontSize: "ui",
  gap: 0.5,
});

// Sized to the title's line, like a browser tab's icon.
const iconStyles = css({
  color: "muted",
  display: "flex",
  flexShrink: 0,
  // Anchors the mark.
  position: "relative",
});

// A dot on the icon's bottom corner, ringed in the bar's color so it reads
// on any icon.
const markStyles = css({
  blockSize: "8px",
  borderRadius: "full",
  boxShadow: "0 0 0 2px {colors.chrome}",
  inlineSize: "8px",
  insetBlockEnd: "-2px",
  insetInlineEnd: "-2px",
  position: "absolute",
});

const iconImageStyles = css({
  height: "16px",
  objectFit: "contain",
  width: "16px",
});

/**
 * The title, in two copies stacked in one cell: its own text in `muted` and,
 * over it, an `::after` copy in `foreground` that the screen reader skips.
 * Raising the bar crossfades them, with `opacity` alone, as `Fill` does its
 * colors.
 */
const titleStyles = cva({
  base: {
    _after: { color: "foreground", content: 'attr(data-title) / ""' },
    "& > *": { color: "muted" },
    "& > *, &::after": {
      gridArea: "1 / 1",
      overflow: "hidden",
      // Centered on its capitals, not its line box, whose extra room below
      // the baseline left the title riding high. Even padding keeps
      // descenders clear of the clip without moving the center.
      paddingBlock: "0.25em",
      textBox: "trim-both cap alphabetic",
      textOverflow: "ellipsis",
      transition: "opacity {durations.fast} {easings.out}",
      whiteSpace: "nowrap",
    },
    display: "grid",
    flex: 1,
    // 13px, the desktop's text size, matching the address bar.
    fontSize: "ui",
    minInlineSize: 0,
  },
  variants: {
    hoverable: {
      false: {},
      // As `Fill`'s hover layer.
      true: {
        "[data-face]:hover & > *": { opacity: 0 },
        "[data-face]:hover &::after": { opacity: 1 },
      },
    },
    lit: {
      false: { _after: { opacity: 0 }, "& > *": { opacity: 1 } },
      true: { _after: { opacity: 1 }, "& > *": { opacity: 0 } },
    },
  },
});

const summaryStyles = vstack({ alignItems: "stretch", gap: 0.5 });

const summaryTitleStyles = css({
  fontWeight: "medium",
  overflowWrap: "anywhere",
});

const summaryDescriptionStyles = css({ color: "muted" });
