import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { css, cva } from "../../styled-system/css";
import { Direction } from "../direction";
import type { Spot } from "../pointer-warp";
import type { Rect } from "../rect";
import { within } from "../rect";
import { placedAt, placedIn } from "../window-styles";
import type { OverviewWindow, ScreenOverview } from "./overview";
import { windowAt } from "./overview";
import { aimedToward } from "./steering";
import { tileAt } from "./tiles";

type Props = {
  /**
   * The workspace the keyboard is on, or `undefined` for the shown one of
   * the `focused` screen. The arrow keys and Tab move it, as do the
   * overview's own keys (see `steeredInOverview`).
   */
  aim: string | undefined;
  /** Which card each tile shows; see `WindowState.overviewCards`. */
  cards: Readonly<Record<string, string>>;
  /** The screen with the keyboard, whose shown workspace takes focus. */
  focused: string;
  /** The keyboard moved to another workspace. */
  onAim: (workspace: string) => void;
  /** Escape, or a press between the tiles. */
  onDismiss: () => void;
  /** A window dropped on another workspace's tile. */
  onMove: (id: string, workspace: string) => void;
  /** A workspace pressed, or chosen from the keyboard. */
  onPick: (workspace: string) => void;
  /** A window pressed. */
  onPickWindow: (id: string) => void;
  overviews: readonly ScreenOverview[];
};

/**
 * Over every window: what the pointer and keyboard act on in the overview.
 *
 * Each screen's workspace area is one layer, with a button over every tile.
 * A press on a window goes to it; anywhere else in a tile goes to its
 * workspace. Dragging a window onto another tile moves it there. The arrow
 * keys move between tiles the way they point, Tab in order, and Enter picks
 * one.
 *
 * Windows ignore the pointer underneath: the layer covers them.
 */
export const OverviewPicker = (props: Props) => (
  <>
    {props.overviews.map((overview) => (
      <ScreenPicker
        key={overview.screen.geometry.name}
        overview={overview}
        {...props}
      />
    ))}
    <Rings {...props} />
  </>
);

/**
 * The rings round the workspace on each screen and the one the keyboard is
 * on, over every screen's picker. Each is keyed by the card under it (see
 * `WindowState.overviewCards`), so a swap slides it with its card, across
 * monitors too, while aiming elsewhere moves it at once.
 */
const Rings = ({ aim, cards, overviews }: Props) => {
  const ringed = (name: string) => cards[name] ?? name;
  const aimed = aim === undefined ? undefined : aimOf(overviews, aim);
  return (
    <div
      aria-hidden
      className={ringsStyles}
      data-overview-rings=""
      style={{ zIndex: PICKER + 1 }}
    >
      {overviews
        .flatMap(({ screen, tiles }) =>
          tiles
            .filter(({ name }) => name === screen.current)
            .map(({ box, name }) => ({ box, card: ringed(name) })),
        )
        // In the cards' order, which a swap leaves as it is: a ring moved in
        // the document would be redrawn, not slid.
        .toSorted((one, other) => one.card.localeCompare(other.card))
        .map(({ box, card }) => (
          <div
            className={ringStyles({ kind: "shown" })}
            data-overview-ring="shown"
            key={`shown ${card}`}
            style={ringAt(box)}
          />
        ))}
      {aimed !== undefined && (
        <div
          className={ringStyles({ kind: "aim" })}
          data-overview-ring="aim"
          key={`aim ${ringed(aimed.name)}`}
          style={ringAt(aimed.box)}
        />
      )}
    </div>
  );
};

/**
 * Inline style placing a ring over `box` with `translate`, so a swap between
 * tiles of one size slides it on the compositor.
 */
const ringAt = (box: Rect): CSSProperties => ({
  blockSize: `${box.height.toString()}px`,
  inlineSize: `${box.width.toString()}px`,
  translate: `${box.x.toString()}px ${box.y.toString()}px`,
});

/** The tile workspace `aim` is on, in any of `overviews`. */
const aimOf = (overviews: readonly ScreenOverview[], aim: string) =>
  overviews
    .flatMap(({ tiles }) => tiles.filter(({ name }) => name === aim))
    .at(0);

/** How far, in page pixels, a press moves before it is a drag. */
const DRAG_SLOP = 6;

/** Over every window, under the lock screen and the desktop's panels. */
const PICKER = 4000;

/** A window being dragged: where it was pressed, and where it is now. */
type Drag = OverviewWindow & { from: Spot; pointerId: number; to: Spot };

const ScreenPicker = ({
  aim,
  focused,
  onAim,
  onDismiss,
  onMove,
  onPick,
  onPickWindow,
  overview,
  overviews,
}: Props & { overview: ScreenOverview }) => {
  const { geometry, current } = overview.screen;
  const area = geometry.workspace;
  const [pressed, setPressed] = useState<Drag | undefined>();
  const [dragging, setDragging] = useState(false);
  // The click a drag ends with picks nothing.
  const dragged = useRef(false);
  // The click a press on a tile ends with dismisses nothing, wherever it is
  // let go.
  const onTile = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const aimedHere = overview.tiles.some(({ name }) => name === aim);
  // The tile with the keyboard, if on this screen.
  const aimed =
    aimedHere || (aim === undefined && geometry.name === focused)
      ? (aim ?? current)
      : undefined;

  useEffect(() => {
    if (aimed !== undefined) {
      layer.current
        ?.querySelector<HTMLElement>(`[data-workspace="${aimed}"]`)
        ?.focus();
    }
  }, [aimed]);

  /**
   * Moves the keyboard `direction` of the tile it is on, if it can: on to
   * the next monitor's at the edge of this one's, as `steeredInOverview`.
   */
  const aimToward = (direction: Direction) => {
    const to = aimedToward(overviews, aimed ?? current, direction);
    if (to !== undefined) {
      onAim(to.name);
    }
  };

  /** Moves the keyboard `by` tiles in order, wrapping. */
  const aimAlong = (by: number) => {
    const { tiles } = overview;
    const at = tiles.findIndex(({ name }) => name === (aimed ?? current));
    const to = tiles[(at + by + tiles.length) % tiles.length];
    if (to !== undefined) {
      onAim(to.name);
    }
  };

  /** Whether `event` is another pointer than the one pressing a window. */
  const other = (event: PointerEvent<HTMLElement>) =>
    pressed !== undefined && event.pointerId !== pressed.pointerId;

  const forget = () => {
    setPressed(undefined);
    setDragging(false);
  };

  const pressedOn = (event: PointerEvent<HTMLElement>) => {
    if (!other(event)) {
      const at: Spot = [event.clientX, event.clientY];
      // Only the main button drags; a drag's click may never come.
      const hit = event.button === 0 ? windowAt(overview, at) : undefined;
      dragged.current = false;
      onTile.current = event.target !== event.currentTarget;
      setPressed(
        hit === undefined
          ? undefined
          : { ...hit, from: at, pointerId: event.pointerId, to: at },
      );
      setDragging(false);
    }
  };

  const movedTo = (event: PointerEvent<HTMLElement>) => {
    if (pressed !== undefined && !other(event)) {
      if ((event.buttons & 1) === 0) {
        // Let go off this screen's picker before it took the pointer.
        forget();
      } else {
        const to: Spot = [event.clientX, event.clientY];
        setPressed({ ...pressed, to });
        if (distance(pressed.from, to) > DRAG_SLOP) {
          // Keeps the release wherever it lands; see `lost`. Not from the
          // press, which would send a plain click to the layer, not the tile.
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }
      }
    }
  };

  const released = (event: PointerEvent<HTMLElement>) => {
    if (!other(event)) {
      if (pressed !== undefined && dragging) {
        dragged.current = true;
        const target = tileAt(overview.tiles, [event.clientX, event.clientY]);
        if (target !== undefined && target.name !== pressed.workspace) {
          onMove(pressed.id, target.name);
        }
      }
      forget();
    }
  };

  // Released off this screen's picker: nothing moves. Not when a tile, which
  // a touch starts captured by, hands the pointer to the layer.
  const lost = (event: PointerEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && !other(event)) {
      forget();
    }
  };

  // Taken away, as by the shell for a gesture of its own.
  const canceled = (event: PointerEvent<HTMLElement>) => {
    if (!other(event)) {
      forget();
    }
  };

  const keyed = (event: KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case "Escape": {
        onDismiss();
        break;
      }
      case "Tab": {
        // The bar and the other screens are behind it.
        aimAlong(event.shiftKey ? -1 : 1);
        event.preventDefault();
        break;
      }
      case "ArrowLeft": {
        aimToward(Direction.Left);
        event.preventDefault();
        break;
      }
      case "ArrowRight": {
        aimToward(Direction.Right);
        event.preventDefault();
        break;
      }
      case "ArrowUp": {
        aimToward(Direction.Up);
        event.preventDefault();
        break;
      }
      case "ArrowDown": {
        aimToward(Direction.Down);
        event.preventDefault();
        break;
      }
      default: {
        break;
      }
    }
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the keys move focus between the tile buttons, a drag between them moves a window, and a click outside them dismisses; Escape does too
    <div
      aria-label="Workspaces"
      className={pickerStyles}
      data-overview-picker=""
      onClick={(event) => {
        if (dragged.current) {
          dragged.current = false;
        } else if (event.target === event.currentTarget && !onTile.current) {
          onDismiss();
        }
      }}
      onKeyDown={keyed}
      onLostPointerCapture={lost}
      onPointerCancel={canceled}
      onPointerDown={pressedOn}
      onPointerMove={movedTo}
      onPointerUp={released}
      ref={layer}
      role="dialog"
      style={placedAt(area, PICKER)}
    >
      {overview.tiles.map(({ box, name }) => (
        <button
          aria-current={name === current ? "true" : undefined}
          aria-label={`Workspace ${name}`}
          className={tileStyles({
            aimed:
              dragging &&
              pressed !== undefined &&
              name !== pressed.workspace &&
              tileAt([{ box, name }], pressed.to) !== undefined,
          })}
          data-workspace={name}
          key={name}
          onClick={(event) => {
            // From the keyboard, which no drag swallows: a touch drag ends
            // with no click to clear `dragged`.
            const hit =
              event.detail === 0
                ? undefined
                : windowAt(overview, [event.clientX, event.clientY]);
            if (event.detail !== 0 && dragged.current) {
              dragged.current = false;
            } else if (hit === undefined) {
              onPick(name);
            } else {
              onPickWindow(hit.id);
            }
          }}
          style={placedIn(within(box, area))}
          type="button"
        />
      ))}
      {pressed !== undefined && dragging && (
        <div
          aria-hidden
          className={ghostStyles}
          style={placedIn(within(carried(pressed), area))}
        />
      )}
    </div>
  );
};

/** The dragged window's box, carried with the pointer. */
const carried = ({ box, from, to }: Drag): Rect => ({
  ...box,
  x: box.x + to[0] - from[0],
  y: box.y + to[1] - from[1],
});

const distance = ([fromX, fromY]: Spot, [toX, toY]: Spot): number =>
  Math.hypot(toX - fromX, toY - fromY);

// A finger drags windows rather than scrolling or zooming the page.
const pickerStyles = css({
  // The rings come in with the names, once the overview has all but landed.
  animation:
    "overviewShowing {durations.normal} {easings.out} {durations.slow} backwards",
  outline: "none",
  touchAction: "none",
});

// A faint ring under the pointer, drawn outside the tile so it never covers
// its windows. The workspace on screen and the one the keyboard is on are
// ringed by `Rings`, over it.
const tileStyles = cva({
  base: {
    _hover: {
      outlineColor: "color-mix(in oklab, {colors.onPhoto} 40%, transparent)",
    },
    backgroundColor: "transparent",
    borderRadius: "md",
    borderStyle: "none",
    cursor: "pointer",
    outlineColor: "transparent",
    outlineOffset: "3px",
    outlineStyle: "solid",
    outlineWidth: "2px",
    padding: 0,
    transition: "outline-color {durations.fast} {easings.out}",
  },
  variants: {
    aimed: { false: {}, true: { outlineColor: "onPhoto" } },
  },
});

// The dragged window, as an outline that follows the pointer.
const ghostStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.accent} 20%, transparent)",
  borderColor: "accent",
  borderRadius: "sm",
  borderStyle: "solid",
  borderWidth: "2px",
  pointerEvents: "none",
});

// Over the pickers, never in the pointer's way. Comes in with them.
const ringsStyles = css({
  animation:
    "overviewShowing {durations.normal} {easings.out} {durations.slow} backwards",
  insetBlockStart: 0,
  insetInlineStart: 0,
  pointerEvents: "none",
  position: "absolute",
});

// Outside the tile, as the hover ring: the accent round the workspace on
// screen, a bolder white round the keyboard's, drawn over it. A swap slides
// them as it does the cards (see `cardStyles` in `OverviewBackdrop`).
const ringStyles = cva({
  base: {
    borderRadius: "md",
    insetBlockStart: 0,
    insetInlineStart: 0,
    outlineColor: "accent",
    outlineOffset: "3px",
    outlineStyle: "solid",
    outlineWidth: "2px",
    position: "absolute",
    transitionDuration: "slower",
    // main-thread animation: sizes ease only where two tiles differ, as across
    // monitors at other scales; within one, only `translate` changes.
    transitionProperty: "translate, block-size, inline-size",
    transitionTimingFunction: "emphasized",
  },
  variants: {
    kind: {
      aim: { outlineColor: "onPhoto", outlineWidth: "3px" },
      shown: {},
    },
  },
});
