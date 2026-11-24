import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactElement, ReactNode, Ref } from "react";
import { useLayoutEffect, useState } from "react";
import { css, cva, cx } from "../../styled-system/css";
import type { ControlVariant } from "../../styled-system/recipes";
import { control } from "../../styled-system/recipes";
import type { ColorToken } from "../../styled-system/tokens";
import { useStableRef } from "../_control/useStableRef";
import type { ExtendProps } from "../extend-props";
import "../stylesheet";

export { SIZES, type Size } from "../control-sizes";

export const VARIANTS = [
  "primary",
  "solid",
  "ghost",
  "outline",
  "success",
  "danger",
  "dangerGhost",
  "warning",
  "accent",
] as const;
export type Variant = (typeof VARIANTS)[number];

type CommonProps = Partial<ControlVariant> & {
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  rounded?: boolean | undefined;
  variant?: Variant | undefined;
} & (
    | {
        afterIcon?: ReactNode | undefined;
        beforeIcon?: ReactNode | undefined;
        children: string;
        /** A longer name than the text, such as "Forget Codex" in a row. */
        label?: string | undefined;
      }
    | {
        afterIcon?: undefined;
        beforeIcon?: undefined;
        /** The icon; `label` names it. */
        children: ReactElement;
        label: string;
      }
  );
type Props =
  | ExtendProps<
      typeof BaseButton,
      CommonProps & {
        href?: undefined;
      }
    >
  | ExtendProps<
      "a",
      CommonProps & {
        href: NonNullable<ComponentProps<"a">["href"]>;
      }
    >;

export const Button = ({
  disabled = false,
  loading = false,
  rounded = false,
  size = "md",
  variant = "primary",
  beforeIcon,
  afterIcon,
  children,
  label,
  ...passthroughProps
}: Props) => {
  // Merges the caller's ref with ours, since `sharedProps` sets `ref` after
  // spreading `passthroughProps`. See `useStableRef`.
  //
  // The cast is safe: `href` selects both the `Props` member and the rendered
  // element, so this is an anchor ref exactly when an anchor renders.
  // TypeScript can't unify the two contravariant ref types.
  const forwarded = passthroughProps.ref as
    | Ref<HTMLAnchorElement | HTMLButtonElement>
    | undefined;
  const [elementRef, setElementRef] = useStableRef<
    HTMLAnchorElement | HTMLButtonElement
  >(forwarded);
  const [renderedLoading, setRenderedLoading] = useState(loading);

  // Ends the loading pulse smoothly. Removing `data-loading` alone would snap
  // the keyframed opacity. So: freeze the current opacity inline, drop
  // `data-loading`, then clear the inline style next frame so the recipe's
  // `opacity` transition animates from there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `elementRef` is a stable RefObject from useStableRef; biome doesn't see through the helper
  useLayoutEffect(() => {
    if (loading === true && renderedLoading === false) {
      setRenderedLoading(true);
    } else if (renderedLoading === true && loading === false) {
      if (elementRef.current !== null) {
        elementRef.current.style.opacity = getComputedStyle(
          elementRef.current,
        ).opacity;
      }
      setRenderedLoading(false);
      requestAnimationFrame(() => {
        if (elementRef.current !== null) {
          elementRef.current.style.opacity = "";
        }
      });
    }
  }, [loading, renderedLoading]);

  const iconOnly = typeof children !== "string";
  const isDisabled = loading === true || disabled === true;
  const sharedProps = {
    "aria-busy": loading === true ? true : undefined,
    "aria-label": label,
    children: iconOnly ? (
      <span className={iconOnlyStyles}>{children}</span>
    ) : (
      <>
        {beforeIcon}
        <span className={labelStyles}>{children}</span>
        {afterIcon}
      </>
    ),
    className: cx(
      "group",
      control({ size }),
      styles({ iconOnly, rounded, variant }),
    ),
    "data-loading": renderedLoading === true ? "" : undefined,
    ref: setElementRef,
  };

  if (passthroughProps.href === undefined) {
    return (
      <BaseButton
        {...passthroughProps}
        {...sharedProps}
        disabled={isDisabled}
      />
    );
  } else {
    // Anchors have no `disabled` attribute, so emulate it: `aria-disabled`,
    // `data-disabled` for the recipe's `_disabled` condition, and a click
    // guard.
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: anchor with href is interactive; onClick is the disabled-state guard that responds to keyboard via the native anchor behavior
      <a
        {...passthroughProps}
        {...sharedProps}
        aria-disabled={isDisabled === true ? true : undefined}
        data-disabled={isDisabled === true ? "" : undefined}
        // biome-ignore lint/a11y/useValidAnchor: anchor is for navigation (has href); onClick only intercepts to block when disabled
        onClick={(event) => {
          if (isDisabled === true) {
            event.preventDefault();
          } else if (passthroughProps.onClick !== undefined) {
            passthroughProps.onClick(event);
          }
        }}
        tabIndex={isDisabled === true ? -1 : passthroughProps.tabIndex}
      />
    );
  }
};

const iconOnlyStyles = css({
  // Anchors don't match `:disabled`, so also check `[data-disabled]`.
  ".group:not([data-disabled]):not(:disabled):active &": { scale: 1.1 },
  ".group:not([data-disabled]):not(:disabled):hover &": { scale: 1.2 },
  // Centers the icon. As plain inline content it sits on the text baseline,
  // below center.
  alignItems: "center",
  display: "inline-flex",
  justifyContent: "center",
  scale: 1,
  transition: "scale {durations.faster} {easings.out}",
});

const labelStyles = css({ paddingInline: "0.25em" });

const tinted = (color: ColorToken, text: ColorToken = "background") => ({
  backgroundColor: {
    _activeEnabled: `color-mix(in oklab, {colors.${color}} 80%, {colors.background})`,
    _hoverEnabled: `color-mix(in oklab, {colors.${color}} 70%, {colors.foreground})`,
    base: color,
  },
  borderColor: "transparent",
  color: text,
});

const ghost = {
  backgroundColor: {
    _activeEnabled: "color-mix(in oklab, {colors.foreground} 10%, transparent)",
    _hoverEnabled: "color-mix(in oklab, {colors.foreground} 5%, transparent)",
    base: "transparent",
  },
  borderColor: "transparent",
  color: {
    _activeEnabled: "color-mix(in oklab, {colors.foreground} 85%, white)",
    _hoverEnabled: "foreground",
    base: "muted",
  },
  // The text is already `muted`, so the usual disabled fade barely shows.
  opacity: { _disabled: "inactive" },
};

const styles = cva({
  base: {
    animation: {
      _loading:
        "pulse {durations.pulse} {easings.in-out} infinite {durations.slow}",
    },
    border: "1px solid transparent",
    cursor: { _disabled: "not-allowed", _loading: "wait", base: "pointer" },
    filter: { _disabled: "saturate(0.6)", base: "none" },
    gap: 0,
    opacity: { _disabled: "disabled", _loading: "pulseMin", base: 1 },
  },
  variants: {
    iconOnly: {
      true: {
        aspectRatio: "square",
        inlineSize: "auto",
        paddingInline: 0,
      },
    },
    rounded: {
      true: { borderRadius: "full" },
    },
    variant: {
      accent: tinted("accent"),
      danger: tinted("danger", "onDanger"),
      // Red text with no fill, for a destructive action that sits among
      // others, such as a row's remove button.
      dangerGhost: {
        ...ghost,
        backgroundColor: {
          _activeEnabled:
            "color-mix(in oklab, {colors.danger} 18%, transparent)",
          _hoverEnabled:
            "color-mix(in oklab, {colors.danger} 10%, transparent)",
          base: "transparent",
        },
        color: {
          _activeEnabled: "color-mix(in oklab, {colors.danger} 85%, white)",
          _hoverEnabled: "danger",
          base: "danger",
        },
      },
      ghost,
      outline: {
        ...ghost,
        borderColor: {
          _activeEnabled: "foreground",
          _hoverEnabled: "muted",
          base: "border",
        },
      },
      primary: {
        backgroundColor: {
          _activeEnabled:
            "color-mix(in oklab, {colors.background} 85%, {colors.foreground})",
          _hoverEnabled:
            "color-mix(in oklab, {colors.background} 70%, {colors.foreground})",
          base: "color-mix(in oklab, {colors.background} 80%, {colors.foreground})",
        },
        borderColor: "transparent",
        color: "foreground",
      },
      solid: {
        backgroundColor: {
          _activeEnabled:
            "color-mix(in oklab, {colors.foreground} 60%, {colors.background})",
          _hoverEnabled:
            "color-mix(in oklab, {colors.foreground} 80%, {colors.background})",
          base: "foreground",
        },
        borderColor: "transparent",
        color: "background",
      },
      success: tinted("success"),
      warning: tinted("warning"),
    },
  },
});
