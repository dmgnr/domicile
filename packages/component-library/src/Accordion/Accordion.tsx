import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import type { ReactNode } from "react";

import { css, cva } from "../../styled-system/css";
import { flex, hstack } from "../../styled-system/patterns";
import type { ExtendProps } from "../extend-props";
import "../stylesheet";

/** One accordion section: its `value` key, button `label` and `content`. */
export type AccordionItem = {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean | undefined;
};

type Props = ExtendProps<
  typeof BaseAccordion.Root<string>,
  {
    items: readonly AccordionItem[];
    /** `sm` gives a smaller, dimmer label, for nested or secondary sections. */
    size?: Size | undefined;
    /**
     * `filled` draws each section as a tile, a step apart, as a panel's
     * rows; `plain` rules them apart.
     */
    surface?: Surface | undefined;
  }
>;

export const SIZES = ["md", "sm"] as const;
export type Size = (typeof SIZES)[number];

export const SURFACES = ["plain", "filled"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * Collapsible sections, styled over the @base-ui/react Accordion.
 *
 * One section opens at a time unless `multiple`. Closed panels unmount, so
 * their content loses state. Drawn in `currentcolor` so it fits any
 * background.
 */
export const Accordion = ({
  items,
  size = "md",
  surface = "plain",
  ...rootProps
}: Props) => (
  <BaseAccordion.Root
    className={rootStyles}
    data-surface={surface}
    {...rootProps}
  >
    {items.map((item) => (
      <BaseAccordion.Item
        className={itemStyles}
        disabled={item.disabled ?? false}
        key={item.value}
        value={item.value}
      >
        <BaseAccordion.Header className={headerStyles}>
          <BaseAccordion.Trigger className={triggerStyles({ size, surface })}>
            <span className={labelStyles({ size })}>{item.label}</span>
            <CaretDownIcon
              className={caretStyles}
              size={size === "sm" ? 10 : 12}
            />
          </BaseAccordion.Trigger>
        </BaseAccordion.Header>
        <BaseAccordion.Panel className={panelStyles}>
          <div className={contentStyles({ surface })}>{item.content}</div>
        </BaseAccordion.Panel>
      </BaseAccordion.Item>
    ))}
  </BaseAccordion.Root>
);

const rootStyles = flex({
  "&[data-surface=filled]": { gap: 1 },
  direction: "column",
  inlineSize: "100%",
});

// Divider between sections, tinted from `currentcolor`; or each a tile,
// lit under the pointer, padded as a `ListRow`.
const itemStyles = css({
  "[data-surface=filled] > &": {
    backgroundColor: "fill",
    borderRadius: "lg",
  },
  "[data-surface=plain] > & + &": {
    borderBlockStart: "1px solid {colors.divider}",
  },
});

const headerStyles = css({
  margin: 0,
});

const triggerStyles = cva({
  base: hstack.raw({
    _disabled: {
      cursor: "not-allowed",
      opacity: "disabled",
    },
    _focusVisible: {
      backgroundColor: "color-mix(in oklab, currentcolor 12%, transparent)",
      outlineColor: "transparent",
    },
    _hoverEnabled: {
      backgroundColor: "color-mix(in oklab, currentcolor 8%, transparent)",
    },
    backgroundColor: "transparent",
    borderRadius: "sm",
    borderStyle: "none",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
    gap: 2,
    inlineSize: "100%",
    justify: "space-between",
    paddingInline: 1,
    textAlign: "start",
    transition: "background-color {durations.fast} {easings.out}",
  }),
  variants: {
    size: {
      md: { paddingBlock: 1.5 },
      sm: { fontSize: "xs", opacity: 0.75, paddingBlock: 1 },
    },
    surface: {
      filled: {
        _hoverEnabled: { backgroundColor: "fillHover" },
        borderRadius: "lg",
        minBlockSize: 8,
        paddingInline: 2,
        textStyle: "panelLabel",
      },
      plain: {},
    },
  },
});

const labelStyles = cva({
  base: {
    flexGrow: 1,
    minInlineSize: 0,
  },
  variants: {
    size: {
      md: { fontWeight: "medium" },
      sm: {},
    },
  },
});

// Flips while the section is open; base-ui sets `data-panel-open`.
const caretStyles = css({
  "[data-panel-open] > &": {
    transform: "rotate(180deg)",
  },
  flexShrink: 0,
  transition: "transform {durations.normal} {easings.out}",
});

// Animates height using the value base-ui measures.
const panelStyles = css({
  "&[data-ending-style], &[data-starting-style]": {
    blockSize: 0,
  },
  blockSize: "var(--accordion-panel-height)",
  overflow: "hidden",
  // main-thread animation: opens to its content's height once, moving what is
  // below.
  transition: "block-size {durations.normal} {easings.out}",
});

const contentStyles = cva({
  base: { paddingBlock: 2 },
  variants: {
    surface: {
      filled: { paddingBlockStart: 1, paddingInline: 2 },
      plain: { paddingInline: 1 },
    },
  },
});
