import type { ReactNode } from "react";
import { useId } from "react";

import { css, cva } from "../../styled-system/css";

/** Phosphor weights an animated icon is drawn in. */
export type Weight = "bold" | "fill" | "regular";

/**
 * The slash across an icon that is off, as Phosphor draws its `*Slash`
 * icons: a line in the weight's stroke, and a wider gap cut around it.
 */
const SLASH = {
  bold: { gap: 52, stroke: 24 },
  fill: { gap: 40, stroke: 16 },
  regular: { gap: 40, stroke: 16 },
} satisfies Record<Weight, unknown>;

/** Where Phosphor's slash runs, top start to bottom end. */
const SLASH_LINE = { x1: 48, x2: 208, y1: 40, y2: 216 };

type Props = {
  children: ReactNode;
  /** Names the icon; without one it is decorative. */
  label?: string | undefined;
  size: number;
  /** A slash that draws across the icon while `shown`. */
  slash?: { shown: boolean; weight: Weight } | undefined;
  /** Where it sits, inside an outer drawing. */
  x?: number | undefined;
  y?: number | undefined;
};

/**
 * The `<svg>` an animated icon draws its parts in, on Phosphor's 256-unit
 * grid, with an optional slash.
 */
export const IconFrame = ({ children, label, size, slash, x, y }: Props) => {
  const maskId = useId();
  return (
    <svg
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={frameStyles}
      data-slashed={slash?.shown === true ? "" : undefined}
      fill="currentColor"
      height={size}
      role={label === undefined ? undefined : "img"}
      viewBox="0 0 256 256"
      width={size}
      x={x}
      y={y}
    >
      {slash === undefined ? (
        children
      ) : (
        <>
          <defs>
            <mask
              height="320"
              id={maskId}
              maskUnits="userSpaceOnUse"
              width="320"
              x="-32"
              y="-32"
            >
              <rect fill="white" height="320" width="320" x="-32" y="-32" />
              <line
                {...SLASH_LINE}
                className={slashStyles({ shown: slash.shown })}
                pathLength={100}
                stroke="black"
                strokeLinecap="round"
                strokeWidth={SLASH[slash.weight].gap}
              />
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>{children}</g>
          <line
            {...SLASH_LINE}
            className={slashStyles({ shown: slash.shown })}
            pathLength={100}
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={SLASH[slash.weight].stroke}
          />
        </>
      )}
    </svg>
  );
};

// Parts move a little past the grid's edge.
const frameStyles = css({ flexShrink: 0, overflow: "visible" });

// The dash is the line's `pathLength` long, with a gap twice that after it.
// An offset past its length, room for the round caps included, hides it;
// easing the offset to 0 draws it from the top start.
const slashStyles = cva({
  base: { strokeDasharray: "100 200" },
  variants: {
    shown: {
      false: {
        strokeDashoffset: 130,
        // main-thread animation: draws an icon's stroke; an SVG stroke's dash
        // has no compositor path.
        transition: "stroke-dashoffset {durations.normal} {easings.in}",
      },
      true: {
        strokeDashoffset: 0,
        // main-thread animation: draws an icon's stroke; an SVG stroke's dash
        // has no compositor path.
        transition: "stroke-dashoffset {durations.slow} {easings.out}",
      },
    },
  },
});
