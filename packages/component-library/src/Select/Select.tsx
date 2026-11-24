import { Select as BaseSelect } from "@base-ui/react/select";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CaretUpDownIcon } from "@phosphor-icons/react/dist/ssr/CaretUpDown";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import type {
  ComponentProps,
  MouseEventHandler,
  ReactNode,
  RefCallback,
} from "react";
import { useCallback, useRef, useState } from "react";
import { css, cva, cx } from "../../styled-system/css";
import type { ControlVariant } from "../../styled-system/recipes";
import { control } from "../../styled-system/recipes";
import { controlSizingStyle } from "../_control/controlSizingStyle";
import { focusControlOnMouseDown } from "../_control/focus";
import { PrefixIconStack } from "../_control/PrefixIconStack";
import { useStableRef } from "../_control/useStableRef";
import { wrapperBase } from "../_control/wrapperBase";
import type { Size } from "../control-sizes";
import type { ExtendProps } from "../extend-props";
import { usePopupBoundary } from "../PopupBoundary/PopupBoundary";
import { useClosedWithScene } from "../PopupScene/PopupScene";
import "../stylesheet";

export { SIZES, type Size } from "../control-sizes";

export const SURFACES = ["field", "filled", "quiet"] as const;
export type Surface = (typeof SURFACES)[number];

type Boundary = ComponentProps<
  typeof BaseSelect.Positioner
>["collisionBoundary"];

/** A single option in the select popup. */
export type SelectOption<V> = {
  value: V;
  label: ReactNode;
  /**
   * Plain text for type-ahead search and the trigger. Defaults to `label`
   * when it is a string, else `String(value)`.
   */
  textLabel?: string | undefined;
  disabled?: boolean | undefined;
};

type CommonProps<V> = Partial<ControlVariant> & {
  /**
   * Area the list stays inside, shifting and narrowing to fit. Defaults to
   * its `PopupBoundary`, else its `<Screen>` region, as `Popover` does.
   */
  boundary?: Boundary | undefined;
  /**
   * `field` is a bordered field, as in a form. `filled` is a soft row sized
   * like a panel's rows, whatever `size`, for a panel of tiles and rows. `quiet` is only the value and a
   * caret in the inherited color, for a setting inline in text.
   */
  surface?: Surface | undefined;
  // base-ui uses `null` for "controlled, nothing selected" and `undefined`
  // for uncontrolled; both pass through unchanged.
  defaultValue?: V | null | undefined;
  disabled?: boolean | undefined;
  options: readonly SelectOption<V>[];
  onValueChange?: ((value: V | null) => void) | undefined;
  placeholder?: ReactNode | undefined;
  prefixIcon?: ReactNode | undefined;
  required?: boolean | undefined;
  rounded?: boolean | undefined;
  value?: V | null | undefined;
  width?: number | undefined;
};

type Props<V> = ExtendProps<typeof BaseSelect.Trigger, CommonProps<V>>;

// A dropdown: a field styled like Input, a soft row for a panel, or quiet
// text. The trigger carries `data-control` so `wrapperBase`'s state selectors
// apply to it.
export const Select = <V,>({
  boundary,
  defaultValue,
  disabled,
  name,
  onValueChange,
  options,
  placeholder,
  prefixIcon,
  required,
  rounded = false,
  size = "md",
  surface = "field",
  value,
  width,
  ...triggerProps
}: Props<V>) => {
  const textLabelForOption = (option: SelectOption<V>): string =>
    option.textLabel ??
    (typeof option.label === "string" ? option.label : String(option.value));
  // True from open until base-ui finishes closing and refocuses the trigger.
  // Sets `data-active`, which keeps the wrapper's focus style on through the
  // close animation so it doesn't flash.
  const [active, setActive] = useState(false);
  // Controlled so a label click can't reopen the popup it just closed:
  //   1. mousedown on the label: base-ui's outside-press handler closes it.
  //   2. click on the label: the browser clicks the trigger via `htmlFor`.
  //   3. base-ui treats that synthetic click as a toggle and reopens.
  // A short lockout after closing drops the reopen.
  const [open, setOpen] = useState(false);
  const reopenLockoutRef = useRef(false);
  const reopenLockoutTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  // The popup anchors to the wrapper, not the trigger, so `--anchor-width`
  // is the visible field's width.
  const { attach, boundary: around } = usePopupBoundary(false);
  // The list is portaled out of the panel, so it takes the panel's tone
  // itself and is dark in either theme, as the panel is.
  const [overPhoto, setOverPhoto] = useState(false);
  const attachWrapper = useCallback<RefCallback<HTMLDivElement>>(
    (wrapper) => {
      attach(wrapper);
      setOverPhoto(
        wrapper !== null && wrapper.closest("[data-tone=overPhoto]") !== null,
      );
    },
    [attach],
  );
  const [wrapperRef, setWrapperRef] =
    useStableRef<HTMLDivElement>(attachWrapper);
  const actions = useRef<BaseSelect.Root.Actions | null>(null);
  useClosedWithScene(actions, { open });
  return (
    <BaseSelect.Root<V>
      actionsRef={actions}
      defaultValue={defaultValue}
      disabled={disabled}
      itemToStringLabel={(itemValue) => {
        const match = options.find((option) =>
          Object.is(option.value, itemValue),
        );
        return match === undefined ? "" : textLabelForOption(match);
      }}
      name={name}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen && reopenLockoutRef.current) {
          // `cancel()` keeps base-ui's internal open state in sync.
          eventDetails.cancel();
          return;
        }
        if (!nextOpen) {
          reopenLockoutRef.current = true;
          if (reopenLockoutTimeoutRef.current !== undefined) {
            clearTimeout(reopenLockoutTimeoutRef.current);
          }
          // The label's synthetic click lands a few tasks after the close,
          // so `setTimeout(0)` can clear too early. 100ms covers it and is
          // shorter than a human re-click.
          reopenLockoutTimeoutRef.current = setTimeout(() => {
            reopenLockoutRef.current = false;
            reopenLockoutTimeoutRef.current = undefined;
          }, 100);
        }
        setOpen(nextOpen);
        if (nextOpen) {
          setActive(true);
        }
      }}
      onOpenChangeComplete={(o) => {
        if (!o) {
          setActive(false);
        }
      }}
      onValueChange={(next) => {
        onValueChange?.(next);
      }}
      open={open}
      required={required}
      value={value}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: forwards wrapper-padding clicks to the trigger so the full container is the clickable target; mirrors native <label> behavior */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: forwards wrapper-padding clicks to the trigger so the full container is the clickable target; mirrors native <label> behavior */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the trigger button this onClick forwards to handles every keyboard interaction (Enter/Space to open, Esc to close, arrows to navigate); the wrapper onClick is a mouse-only convenience for click-anywhere-on-the-field */}
      <div
        className={wrapperClassOf(surface, size, rounded)}
        onClick={openTriggerOnWrapperClick}
        onMouseDown={focusControlOnMouseDown}
        ref={setWrapperRef}
        style={controlSizingStyle({ width })}
      >
        <PrefixIconStack prefixIcon={prefixIcon} size={size} />
        <BaseSelect.Trigger
          {...triggerProps}
          className={cx(
            triggerStyles,
            surface !== "field" && inheritColorStyles,
          )}
          data-active={active ? "" : undefined}
          data-control=""
        >
          <BaseSelect.Value className={valueStyles} placeholder={placeholder} />
          <BaseSelect.Icon
            className={caretStyles({ surface })}
            render={
              surface === "filled" ? <CaretUpDownIcon /> : <CaretDownIcon />
            }
          />
        </BaseSelect.Trigger>
      </div>
      <BaseSelect.Portal>
        <BaseSelect.Backdrop className={backdropStyles} />
        <BaseSelect.Positioner
          align="start"
          // Keeps the popup's edge aligned with the wrapper. The default
          // aligns item text with the trigger, which a prefix icon pushes
          // past the wrapper's edge.
          alignItemWithTrigger={false}
          anchor={wrapperRef}
          className={positionerStyles}
          collisionBoundary={boundary ?? around}
          data-tone={overPhoto ? "overPhoto" : undefined}
          side="bottom"
          sideOffset={6}
        >
          <BaseSelect.Popup className={popupStyles}>
            <BaseSelect.List className={listStyles}>
              {options.map((option, index) => (
                <BaseSelect.Item
                  className={itemStyles}
                  disabled={option.disabled}
                  key={index}
                  label={textLabelForOption(option)}
                  value={option.value}
                >
                  <BaseSelect.ItemText className={itemTextStyles}>
                    {option.label}
                  </BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className={itemIndicatorStyles}>
                    <CheckIcon />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
};

// Forwards clicks on the wrapper's padding or prefix icon to the trigger.
// Skips clicks inside the trigger, which already opened it.
const openTriggerOnWrapperClick: MouseEventHandler<HTMLDivElement> = (
  event,
) => {
  if (!(event.target instanceof Node)) {
    return;
  }
  const trigger =
    event.currentTarget.querySelector<HTMLButtonElement>("[data-control]");
  if (trigger === null || trigger.contains(event.target)) {
    return;
  }
  trigger.click();
};

// No field: inherits the surrounding text, tints on hover and while open, and
// shows a focus ring only for keyboard focus.
const quietStyles = css({
  "&:has([data-control]:focus-visible)": {
    outline: "1px solid {colors.accent}",
  },
  "&:has([data-control]:is(:hover, [data-popup-open]))": {
    backgroundColor: "color-mix(in oklab, currentcolor 12%, transparent)",
  },
  alignItems: "center",
  borderRadius: "sm",
  cursor: "pointer",
  display: "inline-flex",
  gap: 1,
  maxInlineSize: "100%",
  paddingInline: 1,
  transition: "background-color {durations.fast} {easings.out}",
});

// A soft row sized and lettered like a panel's `ListRow`: the panel's
// `fill`, lit a step under the pointer and while open, with an inset ring for
// keyboard focus.
const filledStyles = css({
  "&:has([data-control]:focus-visible)": {
    outline: "{spacing.0.5} solid {colors.accent}",
    outlineOffset: "calc({spacing.0.5} * -1)",
  },
  "&:has([data-control]:is(:hover, [data-popup-open]))": {
    backgroundColor: "fillHover",
  },
  alignItems: "center",
  backgroundColor: "fill",
  borderRadius: "lg",
  cursor: { _disabled: "not-allowed", base: "pointer" },
  display: "flex",
  gap: 2.5,
  inlineSize: "100%",
  minBlockSize: 8,
  paddingBlock: 1.5,
  paddingInline: 2,
  textStyle: "panelLabel",
  transition: "background-color {durations.fast} {easings.default}",
});

// Off the field, the value takes the surrounding text's color.
const inheritColorStyles = css({
  color: "inherit",
  gap: 1,
});

const triggerStyles = css({
  "&[data-popup-open]": {
    // The wrapper's focus style already shows the open state.
  },
  alignItems: "center",
  backgroundColor: "transparent",
  borderStyle: "none",
  color: "foreground",
  cursor: { _disabled: "not-allowed", base: "pointer" },
  display: "flex",
  flexGrow: 1,
  fontFamily: "inherit",
  fontSize: "inherit",
  gap: "inherit",
  inlineSize: "100%",
  minInlineSize: 0,
  outlineStyle: "none",
  // The wrapper owns the padding.
  padding: 0,
  textAlign: "start",
});

// Truncates to one line so the field's height stays fixed.
const valueStyles = css({
  flexShrink: 1,
  minInlineSize: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

// The up-and-down caret of a filled select points both ways, so it doesn't
// turn when open.
const caretStyles = cva({
  base: {
    color: "muted",
    flexShrink: 0,
    // Pins the caret to the inline end.
    marginInlineStart: "auto",
    transition: "transform {durations.fast} {easings.default}",
  },
  variants: {
    surface: {
      field: { "&[data-popup-open]": { transform: "rotate(180deg)" } },
      filled: { color: "textSoft" },
      quiet: { "&[data-popup-open]": { transform: "rotate(180deg)" } },
    },
  },
});

// `rounded` adds 1.5 spacing units to the recipe's inline padding
// (`CONTROL_PADDING_INLINE` in `control-sizes.ts`), as in Input. Values are
// literals because Panda's static extractor can't read helper results.
//
// `cursor: pointer` because a click anywhere opens the popup (see
// `openTriggerOnWrapperClick`).
const wrapperStyles = cva({
  base: {
    cursor: { _disabled: "not-allowed", base: "pointer" },
  },
  compoundVariants: [
    { css: { paddingInline: 3 }, rounded: true, size: "xs" },
    { css: { paddingInline: 4 }, rounded: true, size: "sm" },
    { css: { paddingInline: 4.5 }, rounded: true, size: "md" },
    { css: { paddingInline: 5 }, rounded: true, size: "lg" },
    { css: { paddingInline: 5.5 }, rounded: true, size: "xl" },
    { css: { paddingInline: 7 }, rounded: true, size: "2xl" },
    { css: { paddingInline: 9 }, rounded: true, size: "3xl" },
    { css: { paddingInline: 11.5 }, rounded: true, size: "4xl" },
  ],
  variants: {
    rounded: {
      true: { borderRadius: "full" },
    },
    size: {
      "2xl": {},
      "3xl": {},
      "4xl": {},
      lg: {},
      md: {},
      sm: {},
      xl: {},
      xs: {},
    },
  },
});

// Dims the page on touch devices only. With a mouse it stays transparent
// but still catches outside clicks for base-ui's modal mode.
const backdropStyles = css({
  _pointerCoarse: {
    "&[data-ending-style]": {
      opacity: 0,
      transition: "opacity {durations.fast} {easings.in}",
    },
    "&[data-starting-style]": { opacity: 0 },
    backgroundColor: "backdrop",
    opacity: 1,
    transition: "opacity {durations.normal} {easings.out}",
  },
  inset: 0,
  position: "fixed",
  zIndex: "modalBackdrop",
});

const positionerStyles = css({
  // Touch overlay: centered in the viewport. `!important` beats Floating
  // UI's inline styles.
  _touchOverlay: {
    bottom: "auto !important",
    left: "50% !important",
    position: "fixed !important",
    right: "auto !important",
    top: "50% !important",
    transform: "translate(-50%, -50%) !important",
  },
  // Touch sheet: pinned to the viewport bottom with small side insets.
  // `!important` beats Floating UI's inline styles.
  _touchSheet: {
    bottom: "0 !important",
    left: "{spacing.2} !important",
    position: "fixed !important",
    right: "{spacing.2} !important",
    top: "auto !important",
    transform: "none !important",
  },
  outlineStyle: "none",
  zIndex: "modal",
});

const popupStyles = css({
  // In a panel over the wallpaper, with rows inset like the panel's own.
  _onPhoto: {
    borderRadius: "lg",
    paddingInline: 1,
  },
  // Touch overlay: a centered popup that fades and scales in, like
  // `ModalDialog`.
  _touchOverlay: {
    "&[data-ending-style]": {
      opacity: 0,
      transform: "scale(0.96)",
      transition:
        "opacity {durations.fast} {easings.in}, transform {durations.fast} {easings.in}",
    },
    "&[data-starting-style]": {
      opacity: 0,
      transform: "scale(0.96)",
    },
    borderRadius: "xl",
    inlineSize: "auto",
    maxBlockSize: "min(70vh, {spacing.160})",
    maxInlineSize: "min({spacing.120}, 90vw)",
    minInlineSize: "{spacing.80}",
    paddingBlockEnd: 3,
    paddingBlockStart: 3,
    transform: "scale(1)",
    transition:
      "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
  },
  // Touch sheet: a bottom drawer that slides up. The bottom padding clears
  // the iOS home indicator.
  _touchSheet: {
    "&[data-ending-style]": {
      opacity: 1,
      transform: "translateY(100%)",
      transition: "transform {durations.normal} {easings.in}",
    },
    "&[data-starting-style]": {
      opacity: 1,
      transform: "translateY(100%)",
    },
    borderBlockEndWidth: 0,
    borderEndEndRadius: 0,
    borderEndStartRadius: 0,
    borderStartEndRadius: "xl",
    borderStartStartRadius: "xl",
    inlineSize: "auto",
    maxBlockSize: "70vh",
    minInlineSize: "auto",
    paddingBlockEnd: "max({spacing.1.5}, env(safe-area-inset-bottom))",
    paddingBlockStart: 3,
    transition:
      "transform {durations.normal} {easings.out}, opacity {durations.normal} {easings.out}",
  },
  "&[data-ending-style]": {
    opacity: 0,
    transform: "scaleY(0.8)",
    transition:
      "opacity {durations.fast} {easings.in}, transform {durations.fast} {easings.in}",
  },
  // base-ui's attribute instead of Panda's `_starting` throughout:
  // `@starting-style` does not reliably fire for elements mounted in a
  // portal.
  "&[data-starting-style]": {
    opacity: 0,
    transform: "scaleY(0.8)",
  },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "md",
  boxShadow: "lifted",
  // The list scrolls, not the popup, so items stay clipped inside the
  // rounded border.
  display: "flex",
  flexDirection: "column",
  // At least the field's width, and wider for long options up to the
  // available space.
  inlineSize: "max-content",
  maxBlockSize: "min(60vh, {spacing.96})",
  maxInlineSize: "var(--available-width)",
  minInlineSize: "var(--anchor-width)",
  opacity: 1,
  outlineStyle: "none",
  overflow: "hidden",
  paddingBlock: 1,
  transform: "translateY(0) scale(1)",
  // Grows down from the trigger.
  transformOrigin: "top",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

// The scroll container. `minBlockSize: 0` lets it shrink below its content
// so it scrolls instead of growing the popup.
const listStyles = css({
  flexGrow: 1,
  minBlockSize: 0,
  overflowY: "auto",
});

const itemStyles = css({
  _onPhoto: { borderRadius: "md" },
  // Touch targets of at least 48px.
  _pointerCoarse: {
    fontSize: "md",
    paddingBlock: 3.5,
    paddingInline: 4,
  },
  "&[data-disabled]": {
    color: "muted",
    opacity: "disabled",
  },
  // Keyboard highlight and mouse hover look the same.
  "&[data-highlighted], &:hover:not([data-disabled])": {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 8%, transparent)",
  },
  alignItems: "center",
  color: "foreground",
  cursor: { _disabled: "not-allowed", base: "pointer" },
  display: "grid",
  fontSize: "sm",
  gap: 2,
  // Label, then the check indicator.
  gridTemplateColumns: "1fr auto",
  outlineStyle: "none",
  paddingBlock: 1.5,
  paddingInline: 3,
});

const itemTextStyles = css({
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const itemIndicatorStyles = css({
  alignItems: "center",
  color: "accent",
  display: "inline-flex",
  flexShrink: 0,
});

const wrapperClassOf = (surface: Surface, size: Size, rounded: boolean) => {
  switch (surface) {
    case "field":
      return cx(
        control({ size }),
        wrapperBase,
        wrapperStyles({ rounded, size }),
      );
    case "filled":
      return filledStyles;
    case "quiet":
      return quietStyles;
  }
};
