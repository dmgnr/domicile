import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import type { ReactNode } from "react";
import { useRef } from "react";
import { css, cva, cx } from "../../styled-system/css";
import type { ControlVariant } from "../../styled-system/recipes";
import { control } from "../../styled-system/recipes";
import { controlSizingStyle } from "../_control/controlSizingStyle";
import { focusControlOnMouseDown } from "../_control/focus";
import { PrefixIconStack } from "../_control/PrefixIconStack";
import { wrapperBase } from "../_control/wrapperBase";
import type { ExtendProps } from "../extend-props";
import { usePopupBoundary } from "../PopupBoundary/PopupBoundary";
import { useClosedWithScene } from "../PopupScene/PopupScene";
import "../stylesheet";

export { SIZES, type Size } from "../control-sizes";

/** One row of the suggestion list. */
export type Suggestion<V> = {
  /** Passed to `onSuggestionTaken` when this row is taken. */
  value: V;
  /** Field text when this row is highlighted or taken. */
  text: string;
  label: ReactNode;
  /** Secondary text, e.g. where the suggestion came from. */
  description?: ReactNode | undefined;
  /** Drawn at the inline start of the row. */
  icon?: ReactNode | undefined;
};

type CommonProps<V> = Partial<ControlVariant> & {
  /**
   * Highlight the first suggestion as the user types, so Enter takes it.
   *
   * Turn on only when the first suggestion is the obvious match, as in an
   * address bar. Otherwise Enter takes a row the user never looked at.
   */
  autoHighlight?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Shown in place of the list when `suggestions` is empty. */
  emptyMessage?: ReactNode | undefined;
  /**
   * A tinted field with no edge until hovered or focused, as in an address
   * bar, which sits on a toolbar rather than on a page.
   */
  filled?: boolean | undefined;
  onSuggestionTaken?: ((value: V) => void) | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  rounded?: boolean | undefined;
  /**
   * The rows to offer, already filtered and ordered.
   *
   * The caller does the matching, since ranking often uses data the field
   * can't see, such as visit history.
   */
  suggestions: readonly Suggestion<V>[];
  /** Controls rendered at the inline end of the field, inside its border. */
  suffixButtons?: ReactNode | undefined;
  value?: string | undefined;
  width?: number | undefined;
};

type Props<V> = ExtendProps<
  typeof BaseAutocomplete.Input,
  CommonProps<V> &
    // The icon slot ignores the pointer (the invalid indicator animates
    // there), so clickable prefixes go in `prefixButtons` instead.
    (
      | { prefixButtons?: undefined; prefixIcon?: ReactNode | undefined }
      | { prefixButtons: ReactNode; prefixIcon?: undefined }
    )
>;

/**
 * A text field with a suggestion list, wrapping the `@base-ui/react`
 * Autocomplete.
 *
 * Styled like `Input`. The highlighted row fills the field ahead of the caret,
 * as in an address bar, so the user sees what Enter will take.
 */
export const Autocomplete = <V,>({
  autoHighlight = false,
  disabled,
  emptyMessage,
  filled = false,
  onSuggestionTaken,
  onValueChange,
  prefixButtons,
  prefixIcon,
  rounded = false,
  size = "md",
  suggestions,
  suffixButtons,
  value,
  width,
  ...inputProps
}: Props<V>) => {
  const { attach, boundary } = usePopupBoundary(false);
  const actions = useRef<BaseAutocomplete.Root.Actions | null>(null);
  const heard = useClosedWithScene(actions, {});
  return (
    <BaseAutocomplete.Root<Suggestion<V>>
      actionsRef={actions}
      autoHighlight={autoHighlight}
      disabled={disabled}
      items={suggestions}
      itemToStringValue={(suggestion) => suggestion.text}
      // `inline` skips base-ui's filtering; the caller already filtered
      // `suggestions`.
      mode="inline"
      onOpenChange={heard}
      onValueChange={(next) => {
        onValueChange?.(next);
      }}
      value={value}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: focuses the field when the wrapper's padding is clicked; mirrors native <label> behavior without a second label polluting the accessible name */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focuses the field when the wrapper's padding is clicked; mirrors native <label> behavior without a second label polluting the accessible name */}
      <div
        className={cx(
          control({ size }),
          wrapperBase,
          wrapperStyles({ filled, rounded, size }),
        )}
        onMouseDown={focusControlOnMouseDown}
        ref={attach}
        style={controlSizingStyle({ width })}
      >
        {prefixButtons === undefined ? (
          <PrefixIconStack prefixIcon={prefixIcon} size={size} />
        ) : (
          <span className={affixStyles}>{prefixButtons}</span>
        )}
        <BaseAutocomplete.Input
          {...inputProps}
          className={inputStyles}
          data-control=""
        />
        {suffixButtons !== undefined && (
          <span className={affixStyles}>{suffixButtons}</span>
        )}
      </div>
      <BaseAutocomplete.Portal>
        <BaseAutocomplete.Positioner
          align="start"
          className={positionerStyles}
          collisionBoundary={boundary}
          side="bottom"
          sideOffset={6}
        >
          <BaseAutocomplete.Popup className={popupStyles}>
            <BaseAutocomplete.Empty className={emptyStyles}>
              {emptyMessage}
            </BaseAutocomplete.Empty>
            <BaseAutocomplete.List className={listStyles}>
              {suggestions.map((suggestion, index) => (
                <BaseAutocomplete.Item
                  className={itemStyles}
                  index={index}
                  key={index}
                  onClick={() => {
                    onSuggestionTaken?.(suggestion.value);
                  }}
                  value={suggestion}
                >
                  {suggestion.icon !== undefined && (
                    <span className={itemIconStyles}>{suggestion.icon}</span>
                  )}
                  <span className={itemLabelStyles}>{suggestion.label}</span>
                  {suggestion.description !== undefined && (
                    <span className={itemDescriptionStyles}>
                      {suggestion.description}
                    </span>
                  )}
                </BaseAutocomplete.Item>
              ))}
            </BaseAutocomplete.List>
          </BaseAutocomplete.Popup>
        </BaseAutocomplete.Positioner>
      </BaseAutocomplete.Portal>
    </BaseAutocomplete.Root>
  );
};

const inputStyles = css({
  "&::placeholder": { color: "muted" },
  backgroundColor: "transparent",
  borderStyle: "none",
  color: "foreground",
  cursor: { _disabled: "not-allowed", base: "text" },
  flexGrow: 1,
  inlineSize: "100%",
  minInlineSize: 0,
  outlineStyle: "none",
  padding: 0,
  textOverflow: "ellipsis",
});

// Prefix and suffix control rows. They don't shrink and inherit the recipe's
// per-size gap.
const affixStyles = css({
  alignItems: "center",
  display: "inline-flex",
  flexShrink: 0,
  gap: "inherit",
});

// `rounded` adds 1.5 spacing units to the recipe's inline padding
// (`CONTROL_PADDING_INLINE` in `control-sizes.ts`), as in Input. Values are
// literals because Panda's static extractor can't read helper results.
const wrapperStyles = cva({
  base: {
    // Not in `wrapperBase`; see the note at the top of `wrapperBase.ts`.
    cursor: "text",
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
    // `wrapperBase` still draws the hover and focus edges.
    filled: {
      false: {},
      true: {
        backgroundColor: "card",
        borderColor: "transparent",
        borderRadius: "lg",
      },
    },
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

const positionerStyles = css({
  outlineStyle: "none",
  zIndex: "modal",
});

const popupStyles = css({
  "&[data-ending-style]": {
    opacity: 0,
    transform: "scaleY(0.9)",
    transition:
      "opacity {durations.fast} {easings.in}, transform {durations.fast} {easings.in}",
  },
  // base-ui's attribute instead of Panda's `_starting`: `@starting-style`
  // does not reliably fire for elements mounted in a portal.
  "&[data-starting-style]": {
    opacity: 0,
    transform: "scaleY(0.9)",
  },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "md",
  boxShadow: "lifted",
  display: "flex",
  flexDirection: "column",
  // Match the field's width, measured by base-ui's positioner.
  inlineSize: "var(--anchor-width)",
  maxBlockSize: "min(60vh, {spacing.96})",
  opacity: 1,
  outlineStyle: "none",
  overflow: "hidden",
  paddingBlock: 1,
  transform: "scaleY(1)",
  transformOrigin: "top",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

// Always mounted so base-ui can announce changes through it; `:empty` hides
// it.
const emptyStyles = css({
  "&:empty": { display: "none" },
  color: "muted",
  fontSize: "sm",
  paddingBlock: 2,
  paddingInline: 3,
});

const listStyles = css({
  flexGrow: 1,
  minBlockSize: 0,
  overflowY: "auto",
});

const itemStyles = css({
  "&[data-highlighted]": {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 8%, transparent)",
  },
  alignItems: "center",
  color: "foreground",
  columnGap: 2,
  cursor: "pointer",
  display: "grid",
  fontSize: "sm",
  // Icon, label filling the rest, description at the inline end.
  gridTemplateColumns: "auto 1fr auto",
  outlineStyle: "none",
  paddingBlock: 1.5,
  paddingInline: 3,
});

const itemIconStyles = css({
  alignItems: "center",
  color: "muted",
  display: "inline-flex",
});

const itemLabelStyles = css({
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const itemDescriptionStyles = css({
  color: "muted",
  fontSize: "xs",
  whiteSpace: "nowrap",
});
