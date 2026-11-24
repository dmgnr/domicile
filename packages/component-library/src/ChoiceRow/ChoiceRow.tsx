import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import type { ReactNode } from "react";

import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import type { ExtendProps } from "../extend-props";
import "../stylesheet";

/** What a row shows: `icon`, then `name` over `detail`. */
type Content = {
  detail?: string | undefined;
  icon: ReactNode;
  name: string;
};

type RadioRowProps = ExtendProps<typeof Radio.Root, Content>;

/**
 * A row of a list that picks one thing, framed in the accent color while
 * picked. Goes in a `RadioGroup`, such as `ChoiceList`. The screenshot
 * picker's rows are these.
 */
export const RadioRow = ({ detail, icon, name, ...props }: RadioRowProps) => (
  <Radio.Root {...props} className={rowStyles}>
    <RowContent detail={detail} icon={icon} name={name} />
  </Radio.Root>
);

type CheckboxRowProps = ExtendProps<typeof Checkbox.Root, Content>;

/**
 * A row of a list that picks several things, with a checkbox before its
 * icon. Unlike {@link RadioRow} it takes no frame while checked, so a list
 * with many checked stays calm. Goes in a `CheckboxGroup`.
 */
export const CheckboxRow = ({
  detail,
  icon,
  name,
  ...props
}: CheckboxRowProps) => (
  <Checkbox.Root {...props} className={checkboxRowStyles}>
    <span className={boxStyles} data-box="">
      <Checkbox.Indicator className={tickStyles}>
        <CheckIcon aria-hidden weight="bold" />
      </Checkbox.Indicator>
    </span>
    <RowContent detail={detail} icon={icon} name={name} />
  </Checkbox.Root>
);

type ChoiceListProps<Value> = ExtendProps<typeof RadioGroup<Value>>;

/** A column of {@link RadioRow}s, one of which is picked. */
export const ChoiceList = <Value,>(props: ChoiceListProps<Value>) => (
  <RadioGroup<Value> {...props} className={listStyles} />
);

const RowContent = ({ detail, icon, name }: Content) => (
  <>
    {icon}
    <span className={textStyles}>
      <span className={nameStyles}>{name}</span>
      {detail !== undefined && <span className={detailStyles}>{detail}</span>}
    </span>
  </>
);

const listStyles = flex({ direction: "column", gap: 1 });

// Over the wallpaper, as in a bar's popover, the rows take the panel's white
// text, since `foreground` and `muted` follow the theme and the panel does not.
const rowRaw = css.raw({
  _checked: {
    backgroundColor: "color-mix(in oklab, {colors.accent} 20%, transparent)",
    borderColor: "accent",
  },
  _hoverEnabled: {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 6%, transparent)",
  },
  "[data-tone=overPhoto] &": {
    "& > :is(svg, img)": { color: "inherit", opacity: 0.75 },
    "&:hover:not([data-checked])": {
      backgroundColor: "color-mix(in oklab, currentcolor 12%, transparent)",
    },
    color: "inherit",
  },
  "& > :is(svg, img)": {
    blockSize: 5,
    color: "muted",
    flexShrink: 0,
    inlineSize: 5,
  },
  alignItems: "center",
  backgroundColor: "transparent",
  border: "1px solid transparent",
  borderRadius: "md",
  color: "foreground",
  cursor: "pointer",
  display: "flex",
  flexShrink: 0,
  font: "inherit",
  gap: 2.5,
  minInlineSize: 0,
  paddingBlock: 1.5,
  paddingInline: 2.5,
  textAlign: "start",
  transition: "background-color {durations.fast} {easings.out}",
});

const rowStyles = css(rowRaw);

// A row's look without the picked frame; the box shows the check.
const checkboxRowStyles = css(rowRaw, {
  _checked: {
    backgroundColor: "transparent",
    borderColor: "transparent",
  },
  "&[data-checked] [data-box]": {
    backgroundColor: "accent",
    borderColor: "accent",
  },
  "&[data-checked]:hover": {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 6%, transparent)",
  },
});

const boxStyles = css({
  "[data-tone=overPhoto] &": { borderColor: "currentcolor" },
  alignItems: "center",
  blockSize: 4,
  border: "1.5px solid {colors.borderStrong}",
  borderRadius: "sm",
  display: "flex",
  flexShrink: 0,
  inlineSize: 4,
  justifyContent: "center",
  transition:
    "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}",
});

const tickStyles = css({
  "& > svg": { blockSize: 3, inlineSize: 3 },
  color: "background",
  display: "flex",
});

const textStyles = flex({ direction: "column", minInlineSize: 0 });

// The bar's popovers keep their smaller text.
const nameStyles = css({
  "[data-tone=overPhoto] &": { fontSize: "inherit" },
  fontSize: "sm",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const detailStyles = css({
  "[data-tone=overPhoto] &": { color: "inherit", opacity: 0.75 },
  color: "muted",
  fontSize: "xs",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
