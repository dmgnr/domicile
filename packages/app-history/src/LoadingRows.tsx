import type { CSSProperties } from "react";

import { css } from "../styled-system/css";
import { hstack } from "../styled-system/patterns";

/** Title widths, in percent of the row, so the skeleton looks like text. */
const WIDTHS = [72, 54, 88, 46, 64, 80, 38, 58];

/** A day of placeholder rows while the first page loads. */
export const LoadingRows = () => (
  <div aria-label="Loading history" className={rootStyles} role="status">
    <span className={headerStyles} />
    <div className={cardStyles}>
      {WIDTHS.map((width, index) => (
        <div
          className={rowStyles}
          key={width}
          // Not tokens: the bar's share of the row, and its place in the wave.
          style={{ "--index": index, "--width": `${width}%` } as CSSProperties}
        >
          <span className={timeStyles} />
          <span className={tileStyles} />
          <span className={titleStyles} />
        </div>
      ))}
    </div>
  </div>
);

// The highlight is its own layer, slid across with a transform, so the sweep
// runs on the compositor.
const shimmer = {
  _after: {
    animation: "shimmer {durations.shimmer} {easings.in-out} infinite",
    animationDelay: "calc(var(--index, 0) * {durations.fastest})",
    backgroundImage:
      "linear-gradient(90deg, transparent 20%, color-mix(in oklab, {colors.skeleton} 55%, transparent) 50%, transparent 80%)",
    content: '""',
    inset: 0,
    position: "absolute",
  },
  backgroundColor: "color-mix(in oklab, {colors.skeleton} 35%, transparent)",
  borderRadius: "full",
  overflow: "hidden",
  position: "relative",
};

const rootStyles = css({
  animation: "rise {durations.slow} {easings.outQuart} backwards",
  display: "flex",
  flexDirection: "column",
  gap: 3,
});

const headerStyles = css({
  ...shimmer,
  blockSize: 3,
  inlineSize: 56,
  marginBlock: 2.5,
  marginInline: 2,
});

const cardStyles = css({
  _light: {
    backgroundColor:
      "color-mix(in oklab, {colors.background} 82%, transparent)",
  },
  backgroundColor: "color-mix(in oklab, {colors.card} 70%, transparent)",
  border: "1px solid color-mix(in oklab, {colors.foreground} 8%, transparent)",
  borderRadius: "2xl",
  padding: 1.5,
});

const rowStyles = hstack({
  blockSize: 11,
  gap: 3,
  paddingInline: 2,
});

const timeStyles = css({
  ...shimmer,
  blockSize: 2.5,
  flexShrink: 0,
  inlineSize: 12,
  marginInlineStart: 4,
});

const tileStyles = css({
  ...shimmer,
  blockSize: 8,
  borderRadius: "md",
  flexShrink: 0,
  inlineSize: 8,
});

const titleStyles = css({
  ...shimmer,
  blockSize: 3,
  inlineSize: "var(--width)",
});
