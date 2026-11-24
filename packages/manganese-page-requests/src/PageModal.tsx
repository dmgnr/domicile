import type { KeyboardEvent, ReactNode } from "react";
import { useId } from "react";

import { css } from "../styled-system/css";
import { center, flex } from "../styled-system/patterns";

type Props = {
  /** The question, which names the dialog. */
  title: ReactNode;
  /** The text under it, which describes the dialog. */
  message?: ReactNode;
  /** Anything between the text and the buttons. */
  children?: ReactNode;
  /** Small print over the buttons. */
  note?: ReactNode;
  /** The buttons; a `submit` one answers yes. */
  footer: ReactNode;
  /** Escape, as Cancel. */
  onDismiss: () => void;
  /** Enter or the `submit` button. */
  onSubmit: () => void;
};

/**
 * A question over the page it is about, as Chrome's tab-modal dialogs are:
 * the rest of the desktop stays usable. Styled as the library's `ModalDialog`
 * popup. Enter submits and Escape dismisses.
 *
 * Takes no focus itself: the caller focuses an element in it as its own focus
 * rules allow.
 */
export const PageModal = ({
  children,
  footer,
  message,
  note,
  onDismiss,
  onSubmit,
  title,
}: Props) => {
  const titleId = useId();
  const messageId = useId();
  return (
    <div className={scrimStyles}>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape cancels the dialog wherever focus is in it, as base-ui's dialogs do */}
      <form
        aria-describedby={message === undefined ? undefined : messageId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={popupStyles}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="alertdialog"
      >
        <h2 className={titleStyles} id={titleId}>
          {title}
        </h2>
        {message !== undefined && (
          <p className={messageStyles} id={messageId}>
            {message}
          </p>
        )}
        {children}
        {note !== undefined && <p className={noteStyles}>{note}</p>}
        <footer className={footerStyles}>{footer}</footer>
      </form>
    </div>
  );
};

// Dims the page it pauses, as `ModalDialog`'s backdrop dims the screen.
const scrimStyles = center({
  _starting: { opacity: 0 },
  alignItems: "flex-start",
  backgroundColor: "backdrop",
  inset: 0,
  opacity: 1,
  paddingBlockStart: 10,
  paddingInline: 4,
  position: "absolute",
  transition: "opacity {durations.normal} {easings.out}",
});

// `ModalDialog`'s popup, at the top of the page as Chrome places these.
const popupStyles = flex({
  _starting: {
    opacity: 0,
    transform: "translateY({spacing.3}) scale(0.96)",
  },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  boxShadow: "modal",
  direction: "column",
  gap: 4,
  inlineSize: "min({spacing.120}, 100%)",
  opacity: 1,
  outlineStyle: "none",
  padding: 5,
  transform: "translateY(0) scale(1)",
  transition:
    "opacity {durations.normal} {easings.out}, transform {durations.normal} {easings.out}",
});

const titleStyles = css({
  alignItems: "center",
  color: "foreground",
  display: "flex",
  fontSize: "md",
  fontWeight: "semibold",
  gap: 3,
  lineHeight: "snug",
  margin: 0,
  overflowWrap: "anywhere",
});

// A page's message keeps its line breaks; a long one scrolls.
const messageStyles = css({
  color: "foreground",
  fontSize: "sm",
  margin: 0,
  maxBlockSize: 80,
  overflowWrap: "anywhere",
  overflowY: "auto",
  whiteSpace: "pre-wrap",
});

const noteStyles = css({
  color: "muted",
  fontSize: "xs",
  margin: 0,
});

const footerStyles = flex({
  gap: 2,
  justifyContent: "flex-end",
});
