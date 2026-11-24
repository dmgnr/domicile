import type { CSSProperties, ReactNode } from "react";

import { css, cva } from "../../styled-system/css";
import "../stylesheet";

/** How a row comes and goes. See `useLeavingRows`. */
export type RowMotion = {
  /** It came in while its list showed, so it slides in. */
  arriving: boolean;
  /**
   * While it animates out, its place among the rows removed with it, top to
   * bottom, which staggers them.
   */
  leaving: number | undefined;
  /** Its animation out has ended, so it can be dropped. */
  onLeft: () => void;
};

type Props = {
  children: ReactNode;
  motion: RowMotion;
  /** `filled` puts it on its own tile, as a `ListRow` of that surface. */
  surface?: "plain" | "filled" | undefined;
};

/**
 * A list item that slides in as it arrives, and out as it leaves: it slides
 * aside and fades, then its height and the list's gap under it close. Several
 * leaving together go in turn, top to bottom. What leaves is out of reach.
 *
 * The notification drawer's and the downloads panel's rows move this way.
 */
export const LeavingRow = ({
  children,
  motion: { arriving, leaving, onLeft },
  surface = "plain",
}: Props) => (
  <li
    aria-hidden={leaving === undefined ? undefined : true}
    className={rowStyles({ surface })}
    data-arriving={arriving ? "" : undefined}
    data-leaving={leaving === undefined ? undefined : ""}
    data-surface={surface}
    inert={leaving !== undefined}
    onTransitionEnd={(event) => {
      // The height closes last.
      if (
        leaving !== undefined &&
        event.target === event.currentTarget &&
        event.propertyName === "grid-template-rows"
      ) {
        onLeft();
      }
    }}
    style={leaving === undefined ? undefined : leaveOrder(leaving)}
  >
    <div className={bodyStyles}>{children}</div>
  </li>
);

/**
 * Inline style handing `order` to `rowStyles` as `--leave-order`, the delay
 * it is multiplied by. Inline because Panda only extracts build-time literals.
 */
const leaveOrder = (
  order: number,
): CSSProperties & Record<`--${string}`, string> => ({
  "--leave-order": String(Math.min(order, 8)),
});

// A one-row grid, so the height can close.
const rowStyles = cva({
  base: {
    "&[data-arriving]": {
      _starting: {
        opacity: 0,
        transform: "translateX({spacing.4})",
      },
    },
    "&[data-leaving]": {
      gridTemplateRows: "0fr",
      marginBlockEnd: "calc(-1 * {spacing.1})",
      opacity: 0,
      pointerEvents: "none",
      transform: "translateX({spacing.6})",
      // main-thread animation: a row's height opens or closes once, so the rows
      // below make room.
      transition:
        "opacity {durations.normal} {easings.in} calc(var(--leave-order) * {durations.fastest}), transform {durations.normal} {easings.in} calc(var(--leave-order) * {durations.fastest}), grid-template-rows {durations.normal} {easings.in-out} calc(var(--leave-order) * {durations.fastest} + {durations.normal}), margin-block-end {durations.normal} {easings.in-out} calc(var(--leave-order) * {durations.fastest} + {durations.normal})",
    },
    borderRadius: "lg",
    display: "grid",
    gridTemplateRows: "1fr",
    marginBlockEnd: 0,
    minInlineSize: 0,
    opacity: 1,
    overflow: "hidden",
    transform: "translateX(0)",
    // main-thread animation: a row's height opens or closes once, so the rows
    // below make room.
    transition:
      "background-color {durations.fast} {easings.default}, opacity {durations.slow} {easings.outQuart}, transform {durations.slow} {easings.outQuart}, grid-template-rows {durations.normal} {easings.in-out}, margin-block-end {durations.normal} {easings.in-out}",
  },
  variants: {
    surface: {
      filled: { backgroundColor: "fill" },
      plain: {},
    },
  },
});

// Lets the row close past its content's padding.
const bodyStyles = css({
  display: "flex",
  flexDirection: "column",
  minBlockSize: 0,
  minInlineSize: 0,
});
