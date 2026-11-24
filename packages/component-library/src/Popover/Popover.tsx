import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode, RefCallback, RefObject } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { css, cva } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { useStableRef } from "../_control/useStableRef";
import type { ExtendProps } from "../extend-props";
import { usePopupBoundary } from "../PopupBoundary/PopupBoundary";
import { useClosedWithScene } from "../PopupScene/PopupScene";
import { Tooltip } from "../Tooltip/Tooltip";
import "../stylesheet";

export const { createHandle } = BasePopover;

/**
 * Where popovers inside draw their panels; the page's body without one. For a
 * layer above `modal`, such as a lock screen, whose panels must draw over it.
 */
export const PopoverContainer = createContext<HTMLElement | undefined>(
  undefined,
);

/** Which side of its trigger the panel opens on. */
export const SIDES = ["top", "bottom", "inline-start", "inline-end"] as const;
export type Side = (typeof SIDES)[number];

/** Where the panel lines up along that side. */
export const ALIGNMENTS = ["start", "center", "end"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export const TONES = ["card", "overPhoto"] as const;
export type Tone = (typeof TONES)[number];

type Props = ExtendProps<
  typeof BasePopover.Root,
  {
    align?: Alignment | undefined;
    /**
     * What the panel hangs from when it has no trigger, such as a corner of
     * a page. `null` until its ref is set.
     */
    anchor?: HTMLElement | null | undefined;
    children: ReactNode;
    /**
     * Drop the panel's padding and width cap, for content that is its own
     * surface, such as an embedded page.
     */
    flush?: boolean | undefined;
    /**
     * Keep the body in the page while closed, hidden. For content that must
     * keep running, such as an embedded page.
     */
    keepMounted?: boolean | undefined;
    /**
     * Called as the pointer comes onto the panel, padding included, and
     * leaves it, such as to keep one that closes by itself up while used.
     */
    onHoverChange?: ((hovered: boolean) => void) | undefined;
    /**
     * Opened by the app rather than the user, such as to say a download
     * finished: opening it by setting `open` leaves focus where it is. A
     * press on the trigger still focuses it.
     */
    quiet?: boolean | undefined;
    side?: Side | undefined;
    /** Let the panel leave its `PopupBoundary`, such as its window, for its screen. */
    spansWindows?: boolean | undefined;
    title?: ReactNode | undefined;
    /**
     * `overPhoto` is a translucent pill with white text, for panels opened
     * from a bar drawn over the wallpaper.
     */
    tone?: Tone | undefined;
    /** Names the trigger while the pointer rests on it, in its tone. */
    tooltip?: ReactNode | undefined;
    trigger?: ReactElement | undefined;
    /**
     * A wider cap, for a panel of controls whose names would otherwise be
     * cut short — a mixer's devices, say.
     */
    wide?: boolean | undefined;
    /**
     * Lay the panel out without showing it, for a body that is not ready to
     * be seen, such as a page still loading.
     */
    withheld?: boolean | undefined;
  }
>;

/**
 * A non-modal panel anchored to its trigger, for detail the trigger has no
 * room for. Use `ModalDialog` when the user must respond first.
 *
 * Stays inside its `PopupBoundary`, else on the `<Screen>` region of the
 * trigger that opened it, so it never spans two windows or two monitors.
 * Triggers elsewhere open it through a `handle` from `createHandle()`, as
 * `Popover.Trigger`.
 *
 * Closes on an outside press, Escape, or focus leaving it. The focus check
 * catches presses inside out-of-process frames, which the document can't
 * see. Portaled content such as a `Select` list counts as inside. Also
 * closes when its `PopupScene` changes.
 */
const PopoverComponent = ({
  actionsRef,
  align = "center",
  anchor,
  children,
  flush = false,
  keepMounted = false,
  onHoverChange,
  onOpenChange,
  quiet = false,
  side = "bottom",
  spansWindows = false,
  title,
  tone = "card",
  tooltip,
  trigger,
  wide = false,
  withheld = false,
  ...rootProps
}: Props) => {
  const ownActions = useRef<BasePopover.Root.Actions | null>(null);
  const actions = actionsRef ?? ownActions;
  const [popupRef, setPopupRef] = useStableRef<HTMLDivElement>();
  const [triggerRef, setTriggerRef] = useStableRef<HTMLElement>();
  const { attach, boundary } = usePopupBoundary(spansWindows);
  const attachTrigger = useCallback<RefCallback<HTMLElement>>(
    (element) => {
      attach(element);
      return setTriggerRef(element);
    },
    [attach, setTriggerRef],
  );
  // The trigger that opened it, which may be outside this component.
  const opener = useRef<Element | undefined>(undefined);
  // When it last opened, to tell a focus thief from the user moving on.
  const openedAt = useRef(0);
  const within = useRef<FocusEvent | undefined>(undefined);
  const container = useContext(PopoverContainer);
  const heard = useClosedWithScene(actions, {
    defaultOpen: rootProps.defaultOpen,
    onOpenChange: (
      open: boolean,
      details: BasePopover.Root.ChangeEventDetails,
    ) => {
      if (open) {
        openedAt.current = performance.now();
      }
      if (open && details.trigger !== undefined) {
        opener.current = details.trigger;
        attach(details.trigger);
      }
      onOpenChange?.(open, details);
    },
    open: rootProps.open,
  });
  return (
    <BasePopover.Root actionsRef={actions} onOpenChange={heard} {...rootProps}>
      {trigger !== undefined && (
        <Trigger
          attach={attachTrigger}
          tone={tone}
          tooltip={tooltip}
          trigger={trigger}
        />
      )}
      <BasePopover.Portal container={container} keepMounted={keepMounted}>
        <BasePopover.Positioner
          align={align}
          anchor={anchor}
          className={positionerStyles}
          collisionBoundary={boundary}
          onFocus={(event) => {
            within.current = event.nativeEvent;
          }}
          side={side}
          sideOffset={tone === "overPhoto" ? 6 : 8}
        >
          <BasePopover.Popup
            className={popupStyles}
            data-flush={flush ? "" : undefined}
            data-tone={tone}
            data-wide={wide ? "" : undefined}
            data-withheld={withheld ? "" : undefined}
            // The keyboard lands on the first control; a pointer leaves
            // focus on the panel, so no control shows a focus ring it
            // didn't ask for. A quiet one opened by no interaction at all
            // leaves focus alone.
            initialFocus={(openType) => {
              switch (openType) {
                case "keyboard": {
                  return true;
                }
                case "": {
                  return quiet ? false : popupRef.current;
                }
                default: {
                  return popupRef.current;
                }
              }
            }}
            onPointerEnter={() => {
              onHoverChange?.(true);
            }}
            onPointerLeave={() => {
              onHoverChange?.(false);
            }}
            ref={setPopupRef}
          >
            <CloseOnFocusOut
              actions={actions}
              openedAt={openedAt}
              opener={opener}
              popup={popupRef}
              trigger={triggerRef}
              within={within}
            />
            {title !== undefined && (
              <BasePopover.Title className={titleStyles}>
                {title}
              </BasePopover.Title>
            )}
            <div className={bodyStyles({ hasTitle: title !== undefined })}>
              {children}
            </div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
};

/**
 * `Close` is a close button, for panels that need one besides outside press
 * and Escape. `Trigger` opens a popover from elsewhere, given its `handle`.
 */
export const Popover = Object.assign(PopoverComponent, {
  Close: BasePopover.Close,
  Trigger: BasePopover.Trigger,
});

const positionerStyles = css({
  outlineStyle: "none",
  zIndex: "modal",
});

const popupStyles = flex({
  "&[data-ending-style]": {
    opacity: 0,
    transform: "scale(0.96)",
    transition:
      "opacity {durations.fast} {easings.in}, transform {durations.fast} {easings.in}",
  },
  // Clips content to the panel's rounded corners.
  "&[data-flush]": {
    maxInlineSize: "min(90vw, var(--available-width))",
    overflow: "hidden",
    paddingBlock: 0,
    paddingInline: 0,
  },
  // base-ui's attribute instead of Panda's `_starting`: `@starting-style`
  // does not reliably fire for elements mounted in a portal.
  "&[data-starting-style]": {
    opacity: 0,
    transform: "scale(0.96)",
  },
  // The same in both themes, since the wallpaper doesn't change with them.
  // The radius is half a row's height: a pill for one row, a rounded panel
  // for more.
  "&[data-tone=overPhoto]": {
    backdropFilter: "blur({spacing.3})",
    backgroundColor: "panelOverPhoto",
    border: "none",
    borderRadius: "2xl",
    color: "onPhoto",
    paddingBlock: 1.5,
    paddingInline: 3,
    textShadow: "textOverPhoto",
  },
  "&[data-wide]": {
    maxInlineSize: "min(30rem, 90vw, var(--available-width))",
  },
  // Opacity rather than `visibility`, so an embedded page keeps drawing.
  // Showing it plays the opening transition.
  "&[data-withheld]": {
    opacity: 0,
    pointerEvents: "none",
    transform: "scale(0.96)",
  },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  boxShadow: "lifted",
  color: "foreground",
  direction: "column",
  // `--available-width` is the room its `PopupBoundary` leaves it.
  maxInlineSize: "min({spacing.88}, 90vw, var(--available-width))",
  opacity: 1,
  outlineStyle: "none",
  paddingBlock: 3,
  paddingInline: 3.5,
  transform: "scale(1)",
  transformOrigin: "var(--transform-origin)",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

const titleStyles = css({
  color: "foreground",
  fontSize: "sm",
  fontWeight: "semibold",
  lineHeight: "snug",
  margin: 0,
});

const bodyStyles = cva({
  base: {
    "[data-tone=overPhoto] > &": {
      color: "inherit",
    },
    color: "muted",
    display: "flex",
    flexDirection: "column",
    fontSize: "xs",
    gap: 2,
    lineHeight: "normal",
  },
  variants: {
    hasTitle: {
      false: { paddingBlockStart: 0 },
      true: { paddingBlockStart: 1.5 },
    },
  },
});

/**
 * Closes the panel when focus leaves it, its trigger and the trigger that
 * opened it, while open. The popup also lingers closed (kept mounted, or
 * playing its closing transition), and base-ui reports every close, so a close
 * then would close a popover its owner opened in its place.
 *
 * Portaled content counts as inside: React focus events follow the component
 * tree and reach `within` before the document sees them.
 */
/** Sooner than a person can move focus after a panel opens. */
const SNATCHED_WITHIN_MS = 300;

/** An element as a selector-like name, such as `webview#page-12.view`. */
const describeElement = (node: Node): string => {
  if (!(node instanceof Element)) {
    return node.nodeName;
  }
  const id = node.id === "" ? "" : `#${node.id}`;
  const classes = [...node.classList].map((name) => `.${name}`).join("");
  return `${node.localName}${id}${classes}`;
};

const CloseOnFocusOut = ({
  actions,
  openedAt,
  opener,
  popup,
  trigger,
  within,
}: {
  actions: RefObject<BasePopover.Root.Actions | null>;
  openedAt: RefObject<number>;
  opener: RefObject<Element | undefined>;
  popup: RefObject<HTMLDivElement | null>;
  trigger: RefObject<HTMLElement | null>;
  within: RefObject<FocusEvent | undefined>;
}) => {
  useEffect(() => {
    const left = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        event !== within.current &&
        popup.current?.hasAttribute("data-open") === true &&
        popup.current?.contains(target) !== true &&
        trigger.current?.contains(target) !== true &&
        opener.current?.contains(target) !== true
      ) {
        const after = performance.now() - openedAt.current;
        if (after < SNATCHED_WITHIN_MS) {
          // Nobody moves on this fast: something took focus as the panel
          // opened, and the panel looks like it never opened. Say what.
          // biome-ignore lint/suspicious/noConsole: the only trace of a panel that shut as it opened
          console.error(
            `Popover: ${describeElement(target)} took focus ${String(Math.round(after))} ms after the panel opened, which shut it`,
          );
        }
        actions.current?.close();
      }
    };
    document.addEventListener("focusin", left);
    return () => {
      document.removeEventListener("focusin", left);
    };
  }, [actions, openedAt, opener, popup, trigger, within]);
  return undefined;
};

/** The popover's trigger, inside its tooltip's when it has one. */
const Trigger = ({
  attach,
  tone,
  tooltip,
  trigger,
}: {
  attach: RefCallback<HTMLElement>;
  tone: Tone;
  tooltip: ReactNode;
  trigger: ReactElement;
}) => {
  const opener = <BasePopover.Trigger ref={attach} render={trigger} />;
  return tooltip === undefined ? (
    opener
  ) : (
    <Tooltip content={tooltip} tone={tone} trigger={opener} />
  );
};
