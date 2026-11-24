import type { CSSProperties } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { css, cva, cx } from "../styled-system/css";
import { hstack } from "../styled-system/patterns";

/** A chip's distance from the row's start and its width, in px. */
export type Place = { start: number; width: number };

/**
 * Calls `onPlace` with `chip`'s place in its row once the row is laid out and
 * whenever its layout changes, until the returned function stops it.
 */
export type MeasureChip = (
  chip: HTMLElement,
  onPlace: (place: Place) => void,
) => () => void;

type Props = {
  /** The workspace this screen shows. */
  current: string;
  /** Whether this screen has keyboard focus, which decides `current`'s fill. */
  focused: boolean;
  /** Injectable for tests; defaults to a `ResizeObserver` on the row. */
  measureChip?: MeasureChip | undefined;
  onSelect: (name: string) => void;
  /** This screen's workspaces, in order. */
  workspaces: readonly string[];
};

/**
 * The workspace switcher at the bar's start. Like sway's bar, it shows this
 * screen's workspaces that have windows, plus the one on screen.
 *
 * Each is a number. The focused workspace sits under a solid white chip, so it
 * stands out over a bright wallpaper; one visible on another screen gets a
 * white outline; the rest are slightly dimmed and light up under the pointer.
 *
 * The white chip slides between workspaces. It is a black copy of the row on
 * white, clipped to the chip, so each number turns black as the chip passes
 * under it.
 *
 * A plain `<button>` rather than the library's `Button`, which does not support
 * `aria-current` styling or an external `className`. It inherits the bar's
 * color and font.
 */
export const Workspaces = ({
  current,
  focused,
  measureChip = offsetPlace,
  onSelect,
  workspaces,
}: Props) => {
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const [place, setPlace] = useState<Place>();

  useLayoutEffect(() => {
    const chip = chips.current.get(current);
    if (chip === undefined) {
      throw new Error(`manganese: workspace ${current} is not in the bar`);
    }
    return measureChip(chip, setPlace);
  }, [current, measureChip]);

  return (
    <nav aria-label="Workspaces" className={listStyles}>
      {workspaces.map((name) => (
        <button
          // `aria-current` marks the visible workspace. `disabled` would be
          // wrong: a press on it switches back via `workspaceAutoBackAndForth`.
          aria-current={name === current ? "true" : undefined}
          className={cx(
            chipStyles,
            workspaceStyles({ shown: shownAs(name === current, focused) }),
          )}
          data-label={name}
          key={name}
          onClick={() => {
            onSelect(name);
          }}
          ref={(chip) => {
            if (chip === null) {
              chips.current.delete(name);
            } else {
              chips.current.set(name, chip);
            }
          }}
          type="button"
        >
          <span className={labelStyles}>{name}</span>
        </button>
      ))}
      {place !== undefined && (
        <div
          aria-hidden="true"
          className={highlightStyles}
          data-shown={focused}
          data-testid="highlight"
          style={
            {
              "--highlight-start": `${place.start}px`,
              "--highlight-width": `${place.width}px`,
            } as CSSProperties
          }
        >
          {workspaces.map((name) => (
            <span className={chipStyles} data-label={name} key={name}>
              <span className={labelStyles}>{name}</span>
            </span>
          ))}
        </div>
      )}
    </nav>
  );
};

/**
 * `MeasureChip` from offsets, whenever the row resizes. Starts with the
 * observer's first callback, after the frame's layout, rather than reading
 * offsets now: a read while React commits a workspace switch would restyle
 * and lay out the whole desk at once, stalling the slide's first frame.
 */
const offsetPlace: MeasureChip = (chip, onPlace) => {
  const row = chip.parentElement;
  if (row === null) {
    throw new Error("manganese: workspace chip has no row");
  }
  const observer = new ResizeObserver(() => {
    onPlace({
      start: chip.offsetLeft,
      width: chip.offsetWidth,
    });
  });
  observer.observe(row);
  return () => {
    observer.disconnect();
  };
};

// Relative, so the chips' offsets and the highlight are from the row.
const listStyles = hstack({ gap: 0.5, position: "relative" });

// The number and a hidden bold copy share one cell, so every chip is as wide
// as its bold number and the highlight's bold copy lines up with the row.
const chipStyles = css({
  _after: {
    blockSize: 0,
    content: "attr(data-label)",
    fontWeight: "semibold",
    gridArea: "1 / 1",
    overflow: "hidden",
    visibility: "hidden",
  },
  alignItems: "center",
  blockSize: 6,
  borderRadius: "lg",
  display: "grid",
  // 13px, matching the clock.
  fontSize: "ui",
  // Tabular figures keep every number the same width.
  fontVariantNumeric: "tabular-nums",
  // Only matters where `text-box` trim is unsupported.
  lineHeight: "tight",
  minInlineSize: 6,
  paddingBlock: 0,
  paddingInline: 2,
  textAlign: "center",
});

const labelStyles = css({
  gridArea: "1 / 1",
  // Center vertically. Trimming the line box to cap height and baseline
  // leaves only the glyph, so the digit sits centered rather than high.
  textBox: "trim-both cap alphabetic",
});

const workspaceStyles = cva({
  base: {
    // Skips `aria-current`, so the chip keeps its fill under the pointer.
    _hoverEnabled: { backgroundColor: "fillOverPhoto", color: "onPhoto" },
    backgroundColor: "transparent",
    borderStyle: "none",
    color: "color-mix(in oklab, {colors.onPhoto} 85%, transparent)",
    cursor: "pointer",
    fontWeight: "medium",
    // Pressed feedback that is not just color.
    scale: { _active: 0.92, base: 1 },
    transition: `
      background-color {durations.fast} {easings.out},
      color {durations.fast} {easings.out},
      scale {durations.faster} {easings.out}
    `,
  },
  variants: {
    shown: {
      // Under the highlight, which draws it.
      focused: { color: "onPhoto", fontWeight: "semibold" },
      hidden: {},
      // Visible on another screen: an outline, 1.5px, between the spacing
      // scale's 1px and 2px steps.
      visible: {
        boxShadow: "inset 0 0 0 0.09375rem {colors.onPhoto}",
        color: "onPhoto",
        fontWeight: "semibold",
      },
    },
  },
});

// A copy of the row over it, clipped to the current chip. `outBack` overshoots
// the chip a little and settles back. Black needs no shadow, and one would
// smudge it.
const highlightStyles = css({
  "&[data-shown=false]": { opacity: 0 },
  alignItems: "center",
  backgroundColor: "onPhoto",
  // From the start edge only, so the chip slides smoothly while a workspace
  // comes or goes at the row's end and the row's width jumps.
  clipPath:
    "xywh(calc(var(--highlight-start) + {spacing.10}) 0 var(--highlight-width) 100% round {radii.lg})",
  color: "black",
  display: "flex",
  fontWeight: "semibold",
  gap: 0.5,
  insetBlock: 0,
  // Past both ends of the row, so a bounce past the first or last chip is
  // not cut flat.
  insetInline: -10,
  paddingInline: 10,
  pointerEvents: "none",
  position: "absolute",
  textShadow: "none",
  transition: `
    clip-path {durations.slower} {easings.outBack},
    opacity {durations.fast} {easings.out}
  `,
});

const shownAs = (
  current: boolean,
  focused: boolean,
): "focused" | "hidden" | "visible" => {
  if (current) {
    return focused ? "focused" : "visible";
  } else {
    return "hidden";
  }
};
