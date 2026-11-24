import { Button } from "@domicile-desktop/component-library/Button";
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { Input } from "@domicile-desktop/component-library/Input";
import type { NotificationAction } from "@domicile-desktop/sdk/notification";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/dist/ssr/PaperPlaneRight";
import type { RefObject } from "react";
import { Fragment, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { css, cva } from "../styled-system/css";
import type { Density } from "./NotificationCard";

type Props = {
  /** The buttons, other than the reply. */
  buttons: readonly NotificationAction[];
  density: Density;
  /** Called when a button is pressed, with its key. */
  onAction: (key: string) => void;
  /** Called with what is typed in the reply field. */
  onReply: (text: string) => void;
  /** The `inline-reply` action's label, if the notification offers one. */
  replyLabel: string | undefined;
};

/**
 * A strip across the foot of a notification card: its buttons side by side,
 * split by rules, with Reply first if it offers a reply.
 *
 * Reply swaps the buttons for a reply field. Sending, Escape, or leaving the
 * field empty swaps them back. The strip's height and the two rows animate
 * between the two.
 */
export const NotificationActions = ({
  buttons,
  density,
  onAction,
  onReply,
  replyLabel,
}: Props) => {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const replyRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  // `flushSync` lifts `inert` from the row before it takes focus.
  const show = (open: boolean, focus: RefObject<HTMLElement | null>) => {
    flushSync(() => {
      setReplying(open);
    });
    current(focus).focus({ preventScroll: true });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps presses in the strip off the card, whose press is the default action
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the same press, and the same reason
    // biome-ignore lint/a11y/useKeyWithClickEvents: only the pointer's press reaches the card
    <div
      className={stripStyles({ density })}
      data-replying={replying ? "" : undefined}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <div className={rowStyles} inert={replying}>
        <div className={buttonsStyles}>
          {replyLabel !== undefined && (
            <Button
              aria-controls={fieldId}
              aria-expanded={replying}
              onClick={() => {
                show(true, fieldRef);
              }}
              ref={replyRef}
              size="sm"
              variant="ghost"
            >
              {replyLabel}
            </Button>
          )}
          {buttons.map(({ key, label }, index) => (
            <Fragment key={key}>
              {(index > 0 || replyLabel !== undefined) && (
                <span aria-hidden className={ruleStyles} />
              )}
              <Button
                onClick={() => {
                  onAction(key);
                }}
                size="sm"
                variant="ghost"
              >
                {label}
              </Button>
            </Fragment>
          ))}
        </div>
      </div>
      {replyLabel !== undefined && (
        <div className={rowStyles} inert={!replying}>
          <form
            className={formStyles}
            id={fieldId}
            onSubmit={(event) => {
              event.preventDefault();
              onReply(text);
              setText("");
              show(false, replyRef);
            }}
          >
            <Input
              aria-label={replyLabel}
              onBlur={() => {
                if (text === "") {
                  setReplying(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  show(false, replyRef);
                }
              }}
              onValueChange={setText}
              placeholder={replyLabel}
              ref={fieldRef}
              suffixButtons={
                <IconButton disabled={text === ""} label="Send" type="submit">
                  <PaperPlaneRightIcon size={14} />
                </IconButton>
              }
              value={text}
            />
          </form>
        </div>
      )}
    </div>
  );
};

/** The element a ref holds. It is set once the strip renders, so empty throws. */
const current = <T,>(ref: RefObject<T | null>): T => {
  if (ref.current === null) {
    throw new Error("a notification strip's control is not rendered");
  } else {
    return ref.current;
  }
};

// Two grid rows, one per state. The shown row takes `1fr` and the other `0fr`,
// so the strip's height animates between them.
const stripStyles = cva({
  base: {
    "& > :first-child": {
      transform: "translateY(calc(-1 * {spacing.2}))",
    },
    "& > *": {
      opacity: 0,
      transform: "translateY({spacing.2})",
    },
    "&:not([data-replying]) > :first-child, &[data-replying] > :last-child": {
      opacity: 1,
      transform: "translateY(0)",
    },
    "&[data-replying]": { gridTemplateRows: "0fr 1fr" },
    borderBlockStart: "1px solid {colors.divider}",
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateRows: "1fr 0fr",
    // main-thread animation: swaps the actions for the reply field once, moving
    // what is below.
    transition: "grid-template-rows {durations.slow} {easings.outQuart}",
  },
  // Cancels the card's padding so the strip spans it edge to edge. Matches
  // `cardStyles` in `NotificationCard.tsx`.
  variants: {
    density: {
      compact: {
        marginBlockEnd: -2,
        marginBlockStart: 0.5,
        marginInline: -2.5,
      },
      roomy: {
        marginBlockEnd: -3.5,
        marginBlockStart: 1.5,
        marginInline: -3.5,
      },
    },
  },
});

// `minBlockSize: 0` lets a `0fr` row close past its content.
const rowStyles = css({
  minBlockSize: 0,
  overflow: "hidden",
  transition:
    "opacity {durations.slow} {easings.outQuart}, transform {durations.slow} {easings.outQuart}",
});

// The buttons fill the strip edge to edge; the card clips the outer corners.
//
// The keyboard's button gets the wash the launcher's and file picker's picked
// rows use, not a focus ring.
const buttonsStyles = css({
  "& > button": {
    "&:focus-visible": {
      backgroundColor:
        "color-mix(in oklab, {colors.foreground} 10%, transparent)",
      color: "foreground",
      outline: "none",
    },
    blockSize: 9,
    borderRadius: 0,
    flex: 1,
    minInlineSize: 0,
  },
  alignItems: "stretch",
  display: "flex",
});

const ruleStyles = css({
  backgroundColor: "divider",
  flexShrink: 0,
  inlineSize: "1px",
});

const formStyles = css({ padding: 3 });
