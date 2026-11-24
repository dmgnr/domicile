import type { ToastObject } from "@base-ui/react/toast";
import { Toast as BaseToast } from "@base-ui/react/toast";
import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { css } from "../../styled-system/css";
import type { ExtendProps } from "../extend-props";
import "../stylesheet";

export const { createToastManager, useToastManager } = BaseToast;

/** A toast manager created outside React, for `Toaster.Provider`. */
export type ToastManager = ReturnType<typeof createToastManager>;

/** Toast types with their own styling. */
export const TYPES = ["danger"] as const;
export type Type = (typeof TYPES)[number];

type Props<Data extends object> = ExtendProps<
  typeof BaseToast.Viewport,
  {
    /** Renders a toast's content. The toaster draws the card around it. */
    children: (toast: ToastObject<Data>) => ReactNode;
    /** Accessible label for the toast region. */
    label: string;
  }
>;

/**
 * A stack of toasts in the top trailing corner of the containing box.
 *
 * Hovering or focusing the stack expands it and pauses the timers. Toasts with
 * a positive `timeout` show a countdown bar. Wraps base-ui's Toast, so the
 * provider and manager are base-ui's.
 */
const ToasterComponent = <Data extends object>({
  children,
  label,
  ...viewportProps
}: Props<Data>) => {
  const { toasts } = useToastManager<Data>();
  return (
    <BaseToast.Viewport
      aria-label={label}
      className={viewportStyles}
      {...viewportProps}
    >
      {toasts.map((toast) => (
        <ToastRoot key={toast.id} toast={toast}>
          {children(toast)}
        </ToastRoot>
      ))}
    </BaseToast.Viewport>
  );
};

/** How far a press may move and still click; further is a swipe. */
const CLICK_SLOP = 5;

/** Where a press on a toast started. */
type Press = { target: EventTarget; x: number; y: number };

/**
 * One toast: its card, its content and its countdown.
 *
 * The swipe captures the pointer on this root, so the browser sends a press's
 * click here rather than to what was pressed. A press that barely moved is
 * clicked again on the element it started on.
 */
const ToastRoot = <Data extends object>({
  children,
  toast,
}: {
  children: ReactNode;
  toast: ToastObject<Data>;
}) => {
  const press = useRef<Press>(undefined);
  return (
    <BaseToast.Root
      className={rootStyles}
      data-toast=""
      onClick={(event) => {
        const start = press.current;
        if (
          start !== undefined &&
          event.target === event.currentTarget &&
          start.target !== event.currentTarget &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) <=
            CLICK_SLOP
        ) {
          start.target.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              button: event.button,
              cancelable: true,
              clientX: event.clientX,
              clientY: event.clientY,
            }),
          );
        }
      }}
      onPointerDown={(event) => {
        press.current = {
          target: event.target,
          x: event.clientX,
          y: event.clientY,
        };
      }}
      swipeDirection={["right", "up"]}
      toast={toast}
    >
      <BaseToast.Content className={contentStyles}>
        {children}
      </BaseToast.Content>
      {toast.timeout !== undefined && toast.timeout > 0 && (
        <span
          aria-hidden
          className={countdownStyles}
          data-toast-countdown=""
          // Not a token: the bar must end when the toast does.
          style={{ "--toast-timeout": `${toast.timeout}ms` } as CSSProperties}
        />
      )}
    </BaseToast.Root>
  );
};

/** The toast's title, which names it to screen readers. Unstyled. */
const Title = (props: ExtendProps<typeof BaseToast.Title, object>) => (
  <BaseToast.Title render={<span />} {...props} />
);

/** The toast's description, which describes it to screen readers. Unstyled. */
const Description = (
  props: ExtendProps<typeof BaseToast.Description, object>,
) => <BaseToast.Description render={<span />} {...props} />;

export const Toaster = Object.assign(ToasterComponent, {
  Description,
  Provider: BaseToast.Provider,
  Title,
});

// Stacks below modal panels so a toast never covers an open dialog.
const viewportStyles = css({
  inlineSize: "min({spacing.96}, 100%)",
  insetBlockStart: 0,
  insetInlineEnd: 0,
  outlineStyle: "none",
  position: "absolute",
  zIndex: "toast",
});

// Positioned from base-ui's custom properties (`--toast-index`,
// `--toast-offset-y`, swipe movement). Collapsed, cards behind the front one
// shrink, peek below it and take its height. Expanded, each card has its own
// height and a gap.
const rootStyles = css({
  // Covers the gap between expanded cards so the pointer moving between them
  // doesn't collapse the stack.
  _after: {
    blockSize: "calc(var(--gap) + 1px)",
    content: '""',
    insetBlockStart: "100%",
    insetInline: 0,
    position: "absolute",
  },
  _focusVisible: {
    outlineColor: "accent",
  },
  "--gap": "{spacing.2.5}",
  "--height": "var(--toast-frontmost-height, var(--toast-height))",
  "--offset-y":
    "calc(var(--toast-offset-y) + var(--toast-index) * var(--gap) + var(--toast-swipe-movement-y))",
  "--peek": "{spacing.2.5}",
  "--scale": "calc(max(0, 1 - var(--toast-index) * 0.06))",
  "--shrink": "calc(1 - var(--scale))",
  "&[data-ending-style]": {
    opacity: 0,
  },
  // Exit toward the trailing edge, or in the swipe direction if swiped.
  "&[data-ending-style]:not([data-swipe-direction])": {
    transform:
      "translateX(calc(100% + {spacing.6})) translateY(var(--offset-y))",
  },
  "&[data-ending-style][data-swipe-direction=right]": {
    transform:
      "translateX(calc(var(--toast-swipe-movement-x) + 100% + {spacing.6})) translateY(var(--offset-y))",
  },
  "&[data-ending-style][data-swipe-direction=up]": {
    transform: "translateY(calc(var(--toast-swipe-movement-y) - 150%))",
  },
  "&[data-expanded]": {
    blockSize: "var(--toast-height)",
    transform:
      "translateX(var(--toast-swipe-movement-x)) translateY(var(--offset-y))",
  },
  // Over the provider's `limit`: hidden but mounted so it can animate out.
  "&[data-limited]": {
    opacity: 0,
  },
  "&[data-starting-style]": {
    transform: "translateX(calc(100% + {spacing.6}))",
  },
  "&[data-type=danger]": {
    borderColor: "color-mix(in oklab, {colors.danger} 55%, transparent)",
    boxShadow:
      "{shadows.lifted}, 0 0 0 1px color-mix(in oklab, {colors.danger} 25%, transparent)",
  },
  backdropFilter: "blur({spacing.4})",
  backgroundColor: "color-mix(in oklab, {colors.card} 80%, transparent)",
  blockSize: "var(--height)",
  border: "1px solid color-mix(in oklab, {colors.foreground} 12%, transparent)",
  borderRadius: "2xl",
  boxShadow: "lifted",
  boxSizing: "border-box",
  color: "foreground",
  cursor: "default",
  inlineSize: "100%",
  insetBlockStart: 0,
  insetInlineEnd: 0,
  overflow: "hidden",
  position: "absolute",
  transform:
    "translateX(var(--toast-swipe-movement-x)) translateY(calc(var(--toast-swipe-movement-y) + var(--toast-index) * var(--peek) + var(--shrink) * var(--height))) scale(var(--scale))",
  transformOrigin: "top center",
  // main-thread animation: the stack takes the front toast's height, from base-
  // ui's `--height`, once per toast.
  transition:
    "transform {durations.slow} {easings.outQuart}, opacity {durations.slow} {easings.outQuart}, height {durations.fast} {easings.out}",
  userSelect: "none",
  zIndex: "calc(1000 - var(--toast-index))",
});

// Hides the content of cards behind the front one while collapsed, since
// they take the front card's height and would be cut off.
const contentStyles = css({
  "&[data-behind]": {
    opacity: 0,
  },
  "&[data-expanded]": {
    opacity: 1,
  },
  transition: "opacity {durations.normal} {easings.outQuart}",
});

// The countdown bar. It pauses while expanded, matching base-ui's timers.
// Uses physical `left`/`to right` because `linear-gradient` and
// `transform-origin` have no logical keywords.
const countdownStyles = css({
  // Only the front card shows its bar while collapsed.
  "[data-behind] ~ &": {
    opacity: 0,
  },
  "[data-expanded] > &": {
    animationPlayState: "paused",
  },
  "[data-type=danger] > &": {
    backgroundImage: "linear-gradient(to right, transparent, {colors.danger})",
  },
  animationDuration: "var(--toast-timeout)",
  animationFillMode: "forwards",
  animationName: "toastCountdown",
  animationTimingFunction: "linear",
  backgroundImage: "linear-gradient(to right, transparent, {colors.accent})",
  blockSize: 0.5,
  insetBlockEnd: 0,
  insetInline: 0,
  position: "absolute",
  transformOrigin: "left",
  transition: "opacity {durations.normal} {easings.outQuart}",
});
