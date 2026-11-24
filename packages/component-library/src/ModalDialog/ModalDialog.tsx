import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import type {
  ComponentProps,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import { Fragment, useState } from "react";
import { css, cva } from "../../styled-system/css";
import { center, flex, hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import type { ExtendProps } from "../extend-props";
import { useScreenRegion } from "../Screen/DisplayProvider";
import "../stylesheet";

export const { createHandle } = BaseDialog;

/**
 * Where in the viewport the popup sits. Use `top` for launchers, command
 * palettes and find bars.
 */
export const PLACEMENTS = ["center", "top"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * The popup's surface.
 *
 * `glass` is translucent with a blurred backdrop. It suits busy content
 * behind it, such as a desktop; over a flat page it looks like a pale card.
 */
export const SURFACES = ["card", "glass"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * The popup's width. `lg` fits rows with several columns, or a compact list
 * beside a preview; `xl` fits a roomy list beside a preview.
 */
export const SIZES = ["md", "lg", "xl"] as const;
export type Size = (typeof SIZES)[number];

const CloseButton = (props: ComponentProps<typeof Button>) => (
  <BaseDialog.Close render={<Button {...props} />} />
);

type Props = ExtendProps<
  typeof BaseDialog.Root,
  {
    children: ReactNode;
    /** Whether to draw the corner close button. */
    closeButton?: boolean | undefined;
    footer?: ReactNode | undefined;
    placement?: Placement | undefined;
    /**
     * Whether to draw the popup. Turn it off to draw only the backdrop, e.g.
     * on monitors other than the one with keyboard focus.
     */
    popup?: boolean | undefined;
    /**
     * Whether closing focuses what had focus before it opened. Turn it off
     * when the caller places focus itself.
     */
    returnFocus?: boolean | undefined;
    /**
     * Name of the display to center the popup on and dim. Without it, a page
     * that spans several monitors centers it across all of them and dims them
     * all. Needs a `DisplayProvider`.
     */
    screen?: string | undefined;
    size?: Size | undefined;
    surface?: Surface | undefined;
    title?: ReactNode | undefined;
    /**
     * Whether `title` is for screen readers only, as when the popup's first
     * control already says what it is for.
     */
    titleHidden?: boolean | undefined;
    trigger?: ReactElement | undefined;
  }
>;

const ModalDialogComponent = ({
  children,
  closeButton = true,
  footer,
  placement = "center",
  popup = true,
  returnFocus = true,
  screen,
  size = "md",
  surface = "card",
  title,
  titleHidden = false,
  trigger,
  ...rootProps
}: Props) => {
  const region = useScreenRegion(screen);
  const openings = useOpenings(rootProps.open);
  return (
    <BaseDialog.Root {...rootProps}>
      {trigger !== undefined && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal className={portalStyles}>
        {/*
        On the dialog's screen only: its blur costs as much in the gaps
        between monitors as on them. base-ui's own clear backdrop covers the
        page, so a press on another screen still closes the dialog.
      */}
        <BaseDialog.Backdrop
          className={backdropStyles({ surface })}
          data-backdrop=""
          data-surface={surface}
          style={region}
        />
        {/*
        A hidden popup, since closing completes when the popup closes.
        Without one the backdrop would stay and block every click.
      */}
        {!popup && <BaseDialog.Popup finalFocus={returnFocus} hidden />}
        {popup && (
          <BaseDialog.Viewport className={viewportStyles} style={region}>
            {/* Data attributes make the variant visible in the inspector and
            to tests. */}
            <BaseDialog.Popup
              className={popupStyles}
              data-placement={placement}
              data-size={size}
              data-surface={surface}
              finalFocus={returnFocus}
              onKeyDown={moveFooterFocus}
            >
              {title !== undefined && titleHidden && (
                <BaseDialog.Title className={hiddenTitleStyles}>
                  {title}
                </BaseDialog.Title>
              )}
              {title !== undefined && !titleHidden && (
                <header
                  className={headerStyles({ hasCloseButton: closeButton })}
                >
                  <BaseDialog.Title className={titleStyles}>
                    {title}
                  </BaseDialog.Title>
                </header>
              )}
              {closeButton && (
                <span className={closeStyles}>
                  <BaseDialog.Close
                    render={
                      <Button label="Close" variant="ghost">
                        <XIcon />
                      </Button>
                    }
                  />
                </span>
              )}
              <div
                className={bodyStyles({
                  hasCloseButton: closeButton,
                  hasFooter: footer !== undefined,
                  hasTitle: title !== undefined && !titleHidden,
                })}
              >
                {/*
                Keyed to the opening: reopened before its exit animation
                ends, the popup never unmounts, and would keep the last
                opening's state.
              */}
                <Fragment key={openings}>{children}</Fragment>
              </div>
              {footer !== undefined && (
                <footer className={footerStyles}>{footer}</footer>
              )}
            </BaseDialog.Popup>
          </BaseDialog.Viewport>
        )}
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
};

/** Counts the times `open` turned on, so each opening can key fresh content. */
const useOpenings = (open: boolean | undefined) => {
  const [seen, setSeen] = useState(open);
  const [openings, setOpenings] = useState(0);
  if (open !== seen) {
    setSeen(open);
    if (open === true) {
      setOpenings((count) => count + 1);
    }
  }
  return openings;
};

export const ModalDialog = Object.assign(ModalDialogComponent, {
  Close: BaseDialog.Close,
  CloseButton,
});

// One layer per dialog, so a dialog opened over another, such as the
// screenshot dialog over the launcher, dims all of it rather than drawing its
// backdrop between the other's backdrop and popup.
const portalStyles = css({
  position: "relative",
  zIndex: "modal",
});

// Values are literals so Panda's static extractor can see them.
const backdropStyles = cva({
  base: css.raw({
    _starting: {
      opacity: 0,
    },
    "&[data-ending-style]": {
      opacity: 0,
      transition: "opacity {durations.fast} {easings.in}",
    },
    inset: 0,
    opacity: 1,
    position: "fixed",
    transition: "opacity {durations.normal} {easings.out}",
    zIndex: "modalBackdrop",
  }),
  variants: {
    surface: {
      card: {
        backdropFilter: "blur({spacing.0.5})",
        backgroundColor: "backdrop",
      },
      // A lighter scrim and stronger blur, so content stays visible through
      // the glass popup.
      glass: {
        backdropFilter: "blur({spacing.2.5}) saturate(140%)",
        backgroundColor:
          "color-mix(in oklab, {colors.backdrop} 55%, transparent)",
      },
    },
  },
});

// A size container, so `cq*` units are relative to the screen, not a page
// that may span several.
const viewportStyles = center({
  containerType: "size",
  inset: 0,
  overflowY: "auto",
  paddingBlock: "4vh",
  position: "fixed",
  zIndex: "modal",
});

const popupStyles = flex({
  _starting: {
    opacity: 0,
    transform: "translateY({spacing.3}) scale(0.96)",
  },
  "&[data-ending-style]": {
    opacity: 0,
    transform: "translateY({spacing.2}) scale(0.98)",
    transition:
      "opacity {durations.fast} {easings.in}, transform {durations.fast} {easings.in}",
  },
  // Replaces the start auto margin with an offset relative to the screen.
  "&[data-placement=top]": {
    marginBlockEnd: "auto",
    marginBlockStart: "8cqh",
  },
  "&[data-size=lg]": {
    inlineSize: "min({spacing.220}, 92cqw)",
  },
  "&[data-size=xl]": {
    inlineSize: "min({spacing.320}, 92cqw)",
  },
  "&[data-surface=glass]": {
    _before: {
      background:
        "linear-gradient(90deg, transparent, color-mix(in oklab, {colors.foreground} 40%, transparent), transparent)",
      blockSize: "1px",
      content: '""',
      insetBlockStart: 0,
      insetInline: 0,
      position: "absolute",
    },
    backdropFilter: "blur({spacing.5}) saturate(180%)",
    // Near white in light mode: the light card through blur reads as gray.
    backgroundColor: {
      _light: "color-mix(in oklab, {colors.white} 86%, transparent)",
      base: "color-mix(in oklab, {colors.card} 62%, transparent)",
    },
    borderColor: "color-mix(in oklab, {colors.foreground} 16%, transparent)",
  },
  // Makes form controls translucent on glass. Controls mark their element
  // with `data-control`, so its parent is the wrapper that paints the
  // background. The descendant selector outranks the wrapper's own class
  // regardless of order (see `_control/wrapperBase.ts`).
  "&[data-surface=glass] :has(> [data-control]):not([data-flush])": {
    backgroundColor:
      "color-mix(in oklab, {colors.background} 45%, transparent)",
  },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "0.875rem",
  boxShadow: "modal",
  direction: "column",
  inlineSize: "min({spacing.120}, 92cqw)",
  marginBlock: "auto",
  opacity: 1,
  outlineStyle: "none",
  position: "relative",
  transform: "translateY(0) scale(1)",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

// The inline end clears the close button when there is one. Values are
// literals so Panda's static extractor can see them.
const headerStyles = cva({
  base: flex.raw({
    align: "center",
    paddingBlockEnd: 1,
    paddingBlockStart: 4,
    paddingInlineStart: 5,
  }),
  variants: {
    hasCloseButton: {
      false: { paddingInlineEnd: 5 },
      true: { paddingInlineEnd: 12 },
    },
  },
});

const titleStyles = css({
  color: "foreground",
  fontSize: "md",
  fontVariantNumeric: "tabular-nums",
  fontWeight: "semibold",
  lineHeight: "snug",
  margin: 0,
});

const hiddenTitleStyles = css({ srOnly: true });

const closeStyles = css({
  insetBlockStart: 3,
  insetInlineEnd: 3,
  position: "absolute",
});

// Without a title, the top padding clears the close button if there is one.
// Without a footer, the bottom padding is larger. Values are literals so
// Panda's static extractor can see them.
const bodyStyles = cva({
  base: {
    alignItems: "stretch",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    paddingInline: 5,
  },
  compoundVariants: [
    { css: { paddingBlockStart: 10 }, hasCloseButton: true, hasTitle: false },
    { css: { paddingBlockStart: 6 }, hasCloseButton: false, hasTitle: false },
  ],
  variants: {
    hasCloseButton: {
      false: {},
      true: {},
    },
    hasFooter: {
      false: { paddingBlockEnd: 6 },
      true: { paddingBlockEnd: 5 },
    },
    hasTitle: {
      false: {},
      true: { paddingBlockStart: 4 },
    },
  },
});

const footerStyles = hstack({
  gap: 2,
  justify: "flex-end",
  paddingBlockEnd: 4,
  paddingBlockStart: 3,
  paddingInline: 4,
});

/**
 * Moves focus between the footer's enabled buttons on Left, Right, Home and
 * End, when one of them has focus. Left and Right wrap. Focus only moves, so
 * no key here answers a dialog.
 */
const moveFooterFocus = (event: KeyboardEvent<HTMLElement>) => {
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ":scope > footer button:not(:disabled)",
    ),
  ];
  const targets: readonly EventTarget[] = buttons;
  const index = targets.indexOf(event.target);
  if (index !== -1) {
    const target = footerKeyTarget(event.key, buttons, index);
    if (target !== undefined) {
      event.preventDefault();
      target.focus();
    }
  }
};

/** The button `key` moves to from `buttons[index]`, or `undefined` for other keys. */
const footerKeyTarget = (
  key: string,
  buttons: HTMLButtonElement[],
  index: number,
): HTMLButtonElement | undefined => {
  switch (key) {
    case "ArrowLeft":
      return buttons.at(index - 1);
    case "ArrowRight":
      return buttons.at((index + 1) % buttons.length);
    case "Home":
      return buttons.at(0);
    case "End":
      return buttons.at(-1);
    default:
      return undefined;
  }
};
