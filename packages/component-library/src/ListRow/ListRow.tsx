import { Collapsible } from "@base-ui/react/collapsible";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import type { ReactNode } from "react";
import { Children } from "react";

import { css, cva } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import type { Point } from "../ContextMenu/ContextMenu";
import type { RowMotion } from "../LeavingRows/LeavingRow";
import { LeavingRow } from "../LeavingRows/LeavingRow";
import { newTabClick } from "../new-tab-click";
import "../stylesheet";

export const SURFACES = ["plain", "filled"] as const;
export type Surface = (typeof SURFACES)[number];

type Common = {
  /** What goes under the row, across it, such as a field or a refusal. */
  children?: ReactNode | undefined;
  /** A second line, such as a device's battery. */
  detail?: ReactNode | undefined;
  /**
   * Folds `children` behind a toggle at the row's end, named this, such as
   * "Details" for a connection's addresses. They slide open and shut.
   */
  disclosure?: string | undefined;
  /** At the row's end: a figure, a pill, or, on a row that isn't pressed, buttons. */
  end?: ReactNode | undefined;
  /**
   * Shows `end` only while the pointer is on the row or focus is in it, for a
   * list of rows whose buttons would otherwise crowd it, such as downloads.
   * The label runs into its room while it hides.
   */
  endOnHover?: boolean | undefined;
  /** 16px, before the label. */
  icon?: ReactNode | undefined;
  label: ReactNode;
  /**
   * Slides it in as it arrives and out as it leaves, for a list whose rows
   * come and go, such as downloads. See `useLeavingRows`.
   */
  motion?: RowMotion | undefined;
  /**
   * `plain` rows sit on the panel and light under the pointer, as a list of
   * choices; `filled` rows are each a tile, as devices with their own
   * buttons.
   */
  surface?: Surface | undefined;
};

type Props = Common &
  (
    | {
        /**
         * Buttons beside the row's own button rather than in it, such as a
         * pin, after `end`.
         */
        actions?: ReactNode | undefined;
        /** While its request is out. */
        busy?: boolean | undefined;
        /** Names the button, when its text alone would not. */
        name?: string | undefined;
        /** Makes the whole row one button. Its `end` must not be a control. */
        onPress: () => void;
        /**
         * A middle click or a Ctrl+click on the row, for the row's thing
         * elsewhere, as a link opens in a new tab.
         */
        onPressInNew?: (() => void) | undefined;
        /**
         * A right click on the row, where it landed, such as to open the
         * row's thing's own menu there. The page's menu doesn't show.
         */
        onSecondaryPress?: ((at: Point) => void) | undefined;
      }
    | {
        actions?: undefined;
        busy?: undefined;
        name?: undefined;
        onPress?: undefined;
        onPressInNew?: undefined;
        onSecondaryPress?: undefined;
      }
  );

/**
 * One row of a panel's list: an icon, a label over a detail, and something
 * at the end. A row is either one button, such as an inbox, or holds its own
 * buttons, such as a Bluetooth device. Goes in a {@link List}.
 *
 * The label and detail are cut short with an ellipsis rather than wrapping,
 * so rows keep one height.
 */
export const ListRow = ({
  actions,
  busy,
  children,
  detail,
  disclosure,
  end,
  endOnHover = false,
  icon,
  label,
  motion,
  name,
  onPress,
  onPressInNew,
  onSecondaryPress,
  surface = "plain",
}: Props) => {
  const below = Children.toArray(children).length > 0;
  const folds = disclosure !== undefined && below;
  const toggle = folds && (
    <Collapsible.Trigger
      render={
        <Button
          afterIcon={
            <CaretDownIcon
              aria-hidden
              className={caretStyles}
              size={12}
              weight="bold"
            />
          }
          rounded
          size="xs"
          variant="ghost"
        >
          {disclosure}
        </Button>
      }
    />
  );
  const under = (
    <div
      className={belowStyles({ drawer: folds, indented: icon !== undefined })}
    >
      {children}
    </div>
  );
  const face = (
    <>
      {icon !== undefined && (
        <span aria-hidden className={iconStyles}>
          {icon}
        </span>
      )}
      <span className={textStyles}>
        <span className={labelStyles}>{label}</span>
        {detail !== undefined && <span className={detailStyles}>{detail}</span>}
      </span>
      {(end !== undefined || toggle !== false) && (
        <span className={endStyles}>
          {end}
          {toggle}
        </span>
      )}
    </>
  );
  const body = (
    <Collapsible.Root className={rootStyles}>
      {onPress === undefined ? (
        <div className={rowStyles({ pressable: false })}>{face}</div>
      ) : (
        <Beside actions={actions}>
          <button
            aria-busy={busy === true ? true : undefined}
            aria-label={name}
            className={rowStyles({ pressable: true })}
            onContextMenu={
              onSecondaryPress === undefined
                ? undefined
                : (event) => {
                    event.preventDefault();
                    onSecondaryPress({ x: event.clientX, y: event.clientY });
                  }
            }
            type="button"
            {...(onPressInNew === undefined
              ? { onClick: onPress }
              : newTabClick(onPress, onPressInNew))}
          >
            {face}
          </button>
        </Beside>
      )}
      {folds ? (
        <Collapsible.Panel className={drawerStyles}>{under}</Collapsible.Panel>
      ) : (
        below && under
      )}
    </Collapsible.Root>
  );
  return motion === undefined ? (
    <li
      className={itemStyles({ surface })}
      data-end-on-hover={endOnHover ? "" : undefined}
      data-surface={surface}
    >
      {body}
    </li>
  ) : (
    <LeavingRow motion={motion} surface={surface}>
      <div
        className={itemStyles({ surface: "plain" })}
        data-end-on-hover={endOnHover ? "" : undefined}
      >
        {body}
      </div>
    </LeavingRow>
  );
};

/** A pressed row's button, with its `actions` beside it when it has any. */
const Beside = ({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) =>
  actions === undefined ? (
    children
  ) : (
    <div className={pressedStyles}>
      {children}
      <span className={actionsStyles}>{actions}</span>
    </div>
  );

/** A panel's list of {@link ListRow}s. */
export const List = ({
  children,
  label,
}: {
  children: ReactNode;
  /** Names the list, when no heading over it does. */
  label?: string | undefined;
}) => (
  <ul aria-label={label} className={listStyles}>
    {children}
  </ul>
);

// Filled rows sit apart; plain ones nearly touch, as one list.
const listStyles = flex({
  "&:has(> [data-surface=filled])": { gap: 1 },
  direction: "column",
  gap: 0.5,
  listStyle: "none",
  margin: 0,
  minInlineSize: 0,
  padding: 0,
});

const itemStyles = cva({
  base: {
    borderRadius: "lg",
    display: "flex",
    flexDirection: "column",
    minInlineSize: 0,
  },
  variants: {
    surface: {
      filled: { backgroundColor: "fill" },
      plain: {},
    },
  },
});

// The focus ring is inset, so a scrolling list does not clip it.
const rowStyles = cva({
  base: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: "lg",
    borderStyle: "none",
    color: "inherit",
    display: "flex",
    font: "inherit",
    gap: 2.5,
    inlineSize: "100%",
    minBlockSize: 8,
    paddingBlock: 1.5,
    paddingInline: 2,
    textAlign: "start",
  },
  variants: {
    pressable: {
      false: {},
      true: {
        _focusVisible: {
          outline: "{spacing.0.5} solid {colors.accent}",
          outlineOffset: "calc({spacing.0.5} * -1)",
        },
        _hover: { backgroundColor: "fillHover" },
        cursor: "pointer",
        transition: "background-color {durations.fast} {easings.default}",
      },
    },
  },
});

// A pressed row's button, and its actions beside it. The button lights alone
// under the pointer, and shrinks so a long label is cut short instead of
// pushing the actions out.
const pressedStyles = flex({
  "& > button": { flex: 1, minInlineSize: 0 },
  align: "center",
  minInlineSize: 0,
});

// Inset as the row's own end is, so its buttons line up with other rows'.
const actionsStyles = flex({
  align: "center",
  flexShrink: 0,
  gap: 1,
  paddingInlineEnd: 2,
});

// Only there to hold the disclosure's state; the item lays out its parts.
const rootStyles = css({ display: "contents" });

// Flips while the drawer is open; base-ui sets `data-panel-open`.
const caretStyles = css({
  "[data-panel-open] &": { transform: "rotate(180deg)" },
  transition: "transform {durations.normal} {easings.out}",
});

// Opens to the height base-ui measures while what is in it slides down into
// place, and runs back, quicker, to close.
const drawerStyles = css({
  "& > *": {
    transition:
      "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
  },
  "&[data-ending-style]": {
    "& > *": {
      transitionDuration: "{durations.fast}",
      transitionTimingFunction: "{easings.in}",
    },
    transitionDuration: "{durations.fast}",
    transitionTimingFunction: "{easings.in}",
  },
  "&[data-starting-style], &[data-ending-style]": {
    "& > *": { opacity: 0, transform: "translateY(calc({spacing.1.5} * -1))" },
    blockSize: 0,
  },
  blockSize: "var(--collapsible-panel-height)",
  overflow: "hidden",
  // main-thread animation: opens to its details' height once, moving what is
  // below.
  transition: "block-size {durations.normal} {easings.out}",
});

const iconStyles = css({ display: "inline-flex", flexShrink: 0 });

const textStyles = flex({
  direction: "column",
  flex: 1,
  gap: 0.5,
  minInlineSize: 0,
});

const labelStyles = css({
  overflow: "hidden",
  textOverflow: "ellipsis",
  textStyle: "panelLabel",
  whiteSpace: "nowrap",
});

const detailStyles = css({
  color: "textSoft",
  overflow: "hidden",
  textOverflow: "ellipsis",
  textStyle: "panelDetail",
  whiteSpace: "nowrap",
});

// Hidden out of the layout, so the label takes its room until the pointer
// comes. Hidden as for a screen reader rather than not displayed, so Tab still
// reaches its buttons and shows them.
const endStyles = flex({
  "[data-end-on-hover]:not(:hover, :focus-within) &": {
    srOnly: true,
  },
  align: "center",
  color: "textSoft",
  flexShrink: 0,
  gap: 1,
  textStyle: "panelDetail",
});

// Lined up under the label, past the icon and its gap.
const belowStyles = cva({
  base: flex.raw({
    direction: "column",
    gap: 1.5,
    paddingBlockEnd: 2,
    paddingInline: 2,
  }),
  variants: {
    // Room above and below the folded details, as tight as the rows they
    // fold under. A `PanelFooter` in it closes up to its rule to match, so
    // its rule and button sit evenly spaced. Its action stays inside the
    // drawer's padding rather than hanging past it, so it keeps a gap from
    // the tile's edge.
    drawer: {
      false: {},
      true: {
        "& > footer": { paddingBlockStart: 1.5 },
        "& > footer > button:last-child": { marginInlineEnd: 0 },
        gap: 1.5,
        paddingBlockEnd: 1.5,
        paddingBlockStart: 1.5,
      },
    },
    indented: { false: {}, true: { paddingInlineStart: 8.5 } },
  },
});
