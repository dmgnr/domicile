import type { Icon } from "@phosphor-icons/react";

import { css, cva } from "../../styled-system/css";
import { center } from "../../styled-system/patterns";
import "../stylesheet";

export const LAYOUTS = ["panel", "glyph"] as const;
export type Layout = (typeof LAYOUTS)[number];

type Props = {
  /** What it is waiting for, in plain words: `Checking Wi-Fi…`. */
  children: string;
  /**
   * `panel` centers it over its words in the room a waiting panel has, as
   * tall as an `EmptyState` so the panel holds still between them; `glyph` is
   * the spinner alone, at a row's end or a section's heading, with the words
   * for assistive tech.
   */
  layout?: Layout | undefined;
  /**
   * What a panel is searching for, such as Wi-Fi's fan. In place of the
   * spinner, it sits in a soft circle with rings spreading out from it.
   */
  icon?: Icon | undefined;
};

/** What a panel is waiting for. Announced as it changes. */
export const Loading = ({ children, icon: Icon, layout = "panel" }: Props) => {
  switch (layout) {
    case "glyph":
      return (
        <span
          aria-label={children}
          className={rootStyles({ layout })}
          data-layout={layout}
          role="status"
        >
          <span aria-hidden className={spinnerStyles({ layout })} />
        </span>
      );
    case "panel":
      return Icon === undefined ? (
        <span
          className={rootStyles({ layout })}
          data-layout={layout}
          role="status"
        >
          <span aria-hidden className={spinnerStyles({ layout })} />
          {children}
        </span>
      ) : (
        <span
          className={rootStyles({ layout, searching: true })}
          data-layout={layout}
          data-searching
          role="status"
        >
          <span aria-hidden className={radarStyles}>
            <Icon size={22} weight="bold" />
          </span>
          <span className={titleStyles}>{children}</span>
        </span>
      );
  }
};

const rootStyles = cva({
  base: {
    alignItems: "center",
    color: "textSoft",
    display: "flex",
    textStyle: "panelDetail",
  },
  variants: {
    layout: {
      glyph: { display: "inline-flex", flexShrink: 0 },
      panel: {
        flex: 1,
        flexDirection: "column",
        gap: 2.5,
        justifyContent: "center",
        // The same as `EmptyState`'s, so a panel holds still between them.
        minBlockSize: 40,
        paddingBlock: 5,
      },
    },
    // Its words are what the panel is doing now, so they read as a title.
    searching: { true: { color: "inherit" } },
  },
});

// A ring of the divider with a quarter in the text's color. Under reduced
// motion it turns once and rests, and the words say what is happening.
const spinnerStyles = cva({
  base: {
    animation: "spin {durations.spin} {easings.linear} infinite",
    border: "{spacing.0.5} solid {colors.divider}",
    borderBlockStartColor: "currentcolor",
    borderRadius: "full",
    flexShrink: 0,
  },
  variants: {
    layout: {
      glyph: { blockSize: 3.5, inlineSize: 3.5 },
      panel: { blockSize: 5, inlineSize: 5 },
    },
  },
});

// `EmptyState`'s disc, with two rings spreading out from it half a ring
// apart. Under reduced motion they spread once and the disc stays.
const radarStyles = center({
  _after: { animationDelay: "calc({durations.ping} / 2)" },
  "&::before, &::after": {
    animation: "ping {durations.ping} {easings.out} infinite",
    border: "{spacing.0.5} solid currentcolor",
    borderRadius: "full",
    content: '""',
    inset: 0,
    opacity: 0,
    position: "absolute",
  },
  backgroundImage:
    "linear-gradient(150deg, color-mix(in oklab, {colors.accent} 32%, transparent), color-mix(in oklab, {colors.accent} 12%, transparent))",
  blockSize: 12,
  borderRadius: "full",
  boxShadow:
    "inset 0 0 0 1px color-mix(in oklab, {colors.accent} 30%, transparent)",
  color: "color-mix(in oklab, {colors.accent} 70%, currentcolor)",
  inlineSize: 12,
  marginBlockEnd: 1.5,
  position: "relative",
});

const titleStyles = css({ textStyle: "panelLabel" });
