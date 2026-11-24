import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

import { css, cva } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import type { ExtendProps } from "../extend-props";
import "../stylesheet";

/** The tab-bar text size and padding. `md` is the default. */
export const SIZES = ["sm", "md", "lg"] as const;
export type Size = (typeof SIZES)[number];

/** One tab: its `value` key, tab-bar `label` and panel `content`. */
export type TabItem = {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean | undefined;
};

// No `orientation`: the styling is horizontal only. Use `TabRail` for a
// vertical rail.
type Props = Omit<
  ExtendProps<
    typeof BaseTabs.Root,
    {
      tabs: readonly TabItem[];
      size?: Size | undefined;
    }
  >,
  "orientation"
>;

/**
 * A tab bar over a panel, styled over the `@base-ui/react` Tabs.
 *
 * Other `Tabs.Root` props pass through. Inactive panels unmount, so their
 * content loses state.
 */
export const Tabs = ({ tabs, size = "md", ...props }: Props) => (
  <BaseTabs.Root className={rootStyles} {...props}>
    <BaseTabs.List className={listStyles}>
      {tabs.map((tab) => (
        <BaseTabs.Tab
          className={tabStyles({ size })}
          disabled={tab.disabled ?? false}
          key={tab.value}
          value={tab.value}
        >
          {tab.label}
        </BaseTabs.Tab>
      ))}
      <BaseTabs.Indicator className={indicatorStyles} renderBeforeHydration />
    </BaseTabs.List>
    {tabs.map((tab) => (
      <BaseTabs.Panel
        className={panelStyles}
        keepMounted={false}
        key={tab.value}
        value={tab.value}
      >
        {tab.content}
      </BaseTabs.Panel>
    ))}
  </BaseTabs.Root>
);

const rootStyles = flex({
  blockSize: "100%",
  direction: "column",
  minBlockSize: 0,
  minInlineSize: 0,
});

const listStyles = flex({
  // The bottom line as a shadow, not a border, so the indicator can cover it
  // without leaving the list: a list that scrolls would clip it.
  boxShadow: "inset 0 -1px 0 {colors.border}",
  direction: "row",
  gap: 1,
  // Tabs that don't fit scroll sideways instead of widening the page.
  overflowX: "auto",
  // base-ui measures the indicator's offset from this element.
  position: "relative",
  scrollbarWidth: "none",
});

const tabStyles = cva({
  base: {
    _disabled: {
      cursor: "not-allowed",
      opacity: "disabled",
    },
    // A fill instead of the global square outline, which looks wrong on a
    // tab. A transparent outline color hides the outline.
    _focusVisible: {
      backgroundColor: "color-mix(in oklab, {colors.accent} 16%, transparent)",
      outlineColor: "transparent",
    },
    // Hover only lifts inactive, enabled tabs; the active tab keeps its accent.
    _hoverEnabled: {
      backgroundColor: "card",
      color: "foreground",
    },
    _selected: {
      color: "accent",
    },
    background: "transparent",
    border: "none",
    borderRadius: "sm",
    color: "muted",
    cursor: "pointer",
    flex: "none",
    fontWeight: "medium",
    transition:
      "color {durations.fast} {easings.out}, background-color {durations.fast} {easings.out}",
  },
  variants: {
    size: {
      lg: { fontSize: "md", paddingBlock: 2, paddingInline: 4 },
      md: { fontSize: "sm", paddingBlock: 1.5, paddingInline: 3 },
      sm: { fontSize: "xs", paddingBlock: 1, paddingInline: 2.5 },
    },
  },
});

const indicatorStyles = css({
  "&[data-activation-direction=none]": {
    transition: "none",
  },
  backgroundColor: "accent",
  blockSize: "2px",
  inlineSize: "var(--active-tab-width)",
  // Over the list's bottom line.
  insetBlockEnd: 0,
  insetInlineStart: 0,
  position: "absolute",
  transform: "translateX(var(--active-tab-left))",
  // No animation on first paint (`none` direction), so the bar doesn't fly
  // in.
  // main-thread animation: the bar takes the next tab's width once per switch;
  // base-ui gives it in px, which no scale can divide by.
  transition:
    "transform {durations.normal} {easings.outBack}, inline-size {durations.normal} {easings.outBack}",
});

const panelStyles = css({
  // A faint fill instead of the global outline around the whole panel.
  _focusVisible: {
    backgroundColor: "color-mix(in oklab, {colors.accent} 6%, transparent)",
    outlineColor: "transparent",
  },
  borderRadius: "sm",
  flex: 1,
  minBlockSize: 0,
});
