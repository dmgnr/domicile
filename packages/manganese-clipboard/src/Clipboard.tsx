import { Button } from "@domicile-desktop/component-library/Button";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { Input } from "@domicile-desktop/component-library/Input";
import {
  pageOf,
  stepOf,
  steppedTo,
} from "@domicile-desktop/component-library/list-walk";
import { Marked } from "@domicile-desktop/component-library/Marked";
import { ModalDialog } from "@domicile-desktop/component-library/ModalDialog";
import {
  ResultList,
  resultId,
} from "@domicile-desktop/component-library/ResultList";
import { RowTile } from "@domicile-desktop/component-library/RowTile";
import type { ClipboardEntry } from "@domicile-desktop/sdk/desktop/clipboard";
import { ClipboardTextIcon } from "@phosphor-icons/react/dist/ssr/ClipboardText";
import { ImageIcon } from "@phosphor-icons/react/dist/ssr/Image";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/ssr/LinkSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { TextTIcon } from "@phosphor-icons/react/dist/ssr/TextT";
import type { KeyboardEvent } from "react";
import { memo, useId, useRef, useState } from "react";

import { css, cx } from "../styled-system/css";
import { hstack, vstack } from "../styled-system/patterns";
import { CopyKind, kindOf } from "./copy-kind";

/** The box's placeholder and accessible name. */
const PROMPT = "Search what you copied";

/** Glyph size in the box. */
const ICON_SIZE = 16;

type Props = {
  /** The clipboard history, newest first, from the compositor. */
  entries: readonly ClipboardEntry[];
  /** Restores this entry, by its compositor ID, to the clipboard. */
  onCopy: (entry: number) => void;
  /** Escape, a backdrop click, or a chosen row. The desktop decides. */
  onDismiss: () => void;
  /**
   * Drops this entry, by its compositor ID. Removing the current copy empties
   * the clipboard.
   */
  onRemove: (entry: number) => void;
  open: boolean;
  /** The screen to open on: the one with the keyboard. */
  screen: string;
};

/**
 * The clipboard history panel, for restoring an earlier copy. Looks and
 * steers like the launcher: a search box over its rows.
 *
 * A Wayland selection lasts only while the copying client runs, so the
 * compositor keeps the history. Choosing a row asks the compositor to serve
 * that entry as the selection.
 *
 * Open state is desktop state, as with the launcher. Choosing a row reports
 * both the choice and the dismissal, so the panel is gone before the paste.
 */
export const Clipboard = memo(
  ({ entries, onCopy, onDismiss, onRemove, open, screen }: Props) => {
    // The history as of the last render open: choosing a copy moves it to
    // the top, which would reorder the rows while the panel fades out.
    const [shown, setShown] = useState(entries);
    if (open && shown !== entries) {
      setShown(entries);
    }
    return (
      <ModalDialog
        // Keyboard-driven, as the launcher; Escape closes it.
        closeButton={false}
        onOpenChange={(next) => {
          if (!next) {
            onDismiss();
          }
        }}
        open={open}
        screen={screen}
        // Wide enough for several lines of a copy.
        size="lg"
        // Translucent, as the launcher.
        surface="glass"
        // The search box heads the panel, so the title is for screen readers.
        title="Clipboard history"
        titleHidden
      >
        {/*
      Inside the dialog so it unmounts on close, and every open starts with
      an empty box on the previous copy.
    */}
        {shown[0] === undefined ? (
          <EmptyState
            hint="Things you copy show up here."
            icon={ClipboardTextIcon}
            title="Nothing copied yet"
          />
        ) : (
          <History
            earlier={shown[0].current ? shown.slice(1) : shown}
            now={shown[0].current ? shown[0] : undefined}
            onCopy={onCopy}
            onDismiss={onDismiss}
            onRemove={onRemove}
          />
        )}
      </ModalDialog>
    );
  },
);

type HistoryProps = {
  /** The copies before `now`, newest first: the rows. */
  earlier: readonly ClipboardEntry[];
  /** The copy on the clipboard, if any. Removing it leaves none. */
  now: ClipboardEntry | undefined;
  onCopy: (entry: number) => void;
  onDismiss: () => void;
  onRemove: (entry: number) => void;
};

/**
 * The search box over two groups: what is on the clipboard, then the rows the
 * box narrows.
 *
 * A combobox over a listbox, as in the launcher: focus stays in the box and
 * `aria-activedescendant` marks the highlighted row. The current copy is not
 * a row, since choosing it would change nothing, and is not searched.
 */
const History = ({
  earlier,
  now,
  onCopy,
  onDismiss,
  onRemove,
}: HistoryProps) => {
  const listId = useId();
  const nowId = useId();
  const rows = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [stepped, setStepped] = useState(0);
  const searching = query.trim() !== "";
  const shown = matching(earlier, query);
  const highlighted =
    shown.length === 0 ? undefined : Math.min(stepped, shown.length - 1);
  const lit = highlighted === undefined ? undefined : shown[highlighted];

  const pick = (entry: ClipboardEntry) => {
    onCopy(entry.id);
    onDismiss();
  };

  return (
    <div className={panelStyles}>
      <div className={searchStyles}>
        <Input
          aria-activedescendant={
            highlighted === undefined
              ? undefined
              : resultId(listId, highlighted)
          }
          aria-controls={listId}
          aria-expanded
          aria-label={PROMPT}
          autoFocus
          flush
          onChange={(event) => {
            setQuery(event.target.value);
            // Reset, since the old index refers to the previous list.
            setStepped(0);
          }}
          onKeyDown={(event) => {
            // No rows to walk: only the current copy, or nothing matches.
            if (highlighted === undefined) {
              return;
            }
            const step = stepOf(event, pageOf(rows.current));
            if (step !== undefined) {
              // Stop the box from moving the caret.
              event.preventDefault();
              setStepped(steppedTo(highlighted, step, shown.length));
            } else if (event.key === "Enter" && lit !== undefined) {
              event.preventDefault();
              pick(lit);
            } else if (removes(event) && lit !== undefined) {
              event.preventDefault();
              onRemove(lit.id);
            }
          }}
          placeholder={PROMPT}
          prefixIcon={<MagnifyingGlassIcon size={ICON_SIZE} />}
          role="combobox"
          size="lg"
          // Copies are often code or addresses, which would be flagged as
          // misspellings.
          spellCheck={false}
          suffixIcon={
            <span aria-hidden="true" className={countStyles}>
              {countOf(earlier.length, shown.length, searching)}
            </span>
          }
          value={query}
        />
      </div>
      {!searching && now !== undefined && (
        <div aria-labelledby={nowId} className={groupStyles} role="group">
          <div className={groupLabelStyles} id={nowId}>
            On your clipboard
          </div>
          <div className={wellStyles}>
            <div className={nowRowStyles}>
              <Copy entry={now} query="" />
              <span className={nowRemoveStyles}>
                <Remove
                  onRemove={() => {
                    onRemove(now.id);
                  }}
                />
              </span>
            </div>
          </div>
        </div>
      )}
      {(searching || earlier.length > 0) && (
        <div className={groupStyles}>
          {!searching && (
            // The list carries the same name for screen readers.
            <div aria-hidden className={groupLabelStyles}>
              Copied before
            </div>
          )}
          <div className={cx(wellStyles, rowsStyles)} ref={rows}>
            {shown.length === 0 ? (
              <EmptyState
                icon={MagnifyingGlassIcon}
                title="Nothing copied matches"
              />
            ) : (
              <ResultList
                highlighted={highlighted}
                id={listId}
                items={shown}
                keyOf={(entry) => entry.id.toString()}
                label="Copied before"
                onChoose={pick}
                onHighlight={setStepped}
              >
                {(entry) => (
                  <>
                    <Copy entry={entry} query={query} />
                    {entry === lit && (
                      <Remove
                        onRemove={() => {
                          onRemove(entry.id);
                        }}
                        // For the pointer. The keyboard has Delete, and focus
                        // stays in the box, so the button stays out of the
                        // tab order and out of the row's name.
                        pointerOnly
                      />
                    )}
                  </>
                )}
              </ResultList>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** A copy's glyph, picture and text, with what `query` matched in bold. */
const Copy = ({ entry, query }: { entry: ClipboardEntry; query: string }) => (
  <>
    <RowTile icon={glyphOf(kindOf(entry))} />
    {entry.thumbnail !== undefined && (
      // Decorative: the text beside it names what it shows.
      <img alt="" className={pictureStyles} src={entry.thumbnail} />
    )}
    <span className={copyStyles}>
      <Marked query={query} text={entry.preview.trim()} />
    </span>
  </>
);

/**
 * A row's remove button. Its click is not the row's, which would copy the row
 * it just removed.
 */
const Remove = ({
  onRemove,
  pointerOnly = false,
}: {
  onRemove: () => void;
  pointerOnly?: boolean;
}) => (
  <Button
    aria-hidden={pointerOnly ? true : undefined}
    onClick={(event) => {
      event.stopPropagation();
      onRemove();
    }}
    rounded
    size="xs"
    tabIndex={pointerOnly ? -1 : undefined}
    variant="dangerGhost"
  >
    Remove
  </Button>
);

/**
 * Whether a key in the box removes the highlighted row: Delete with nothing
 * after the caret, where the box has nothing for Delete to do.
 */
const removes = (event: KeyboardEvent<HTMLInputElement>): boolean => {
  const { selectionEnd, selectionStart, value } = event.currentTarget;
  return (
    event.key === "Delete" &&
    selectionStart === value.length &&
    selectionEnd === value.length
  );
};

/** The copies whose preview holds every word of `query`, ignoring case. */
const matching = (
  entries: readonly ClipboardEntry[],
  query: string,
): readonly ClipboardEntry[] => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return entries.filter((entry) => {
    const preview = entry.preview.toLowerCase();
    return words.every((word) => preview.includes(word));
  });
};

/** The count at the box's end: the earlier copies, or the matches once narrowed. */
const countOf = (copies: number, shown: number, searching: boolean): string => {
  if (searching) {
    return `${shown.toString()} matched`;
  } else {
    return `${copies.toString()} copied before`;
  }
};

const glyphOf = (kind: CopyKind) => {
  switch (kind) {
    case CopyKind.Image: {
      return ImageIcon;
    }
    case CopyKind.Link: {
      return LinkSimpleIcon;
    }
    case CopyKind.Text: {
      return TextTIcon;
    }
  }
};

const panelStyles = vstack({
  alignItems: "stretch",
  gap: 3,
});

// The search box is the panel's header, set off by a line under it, as in
// the launcher.
const searchStyles = css({
  borderBlockEnd:
    "1px solid color-mix(in oklab, {colors.foreground} 10%, transparent)",
  // Up into the popup's top padding, which is sized for a title.
  marginBlockStart: -3,
  marginInline: -5,
  paddingBlockEnd: 2,
  paddingInline: 3,
});

// Tabular figures, so the count doesn't shift as it changes.
const countStyles = css({
  color: "muted",
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
});

// The launcher's results well, behind each group.
const wellStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 4%, transparent)",
  borderRadius: "md",
  padding: 1,
});

// Tall enough to scroll, short enough to leave the backdrop and the current
// copy's group on a small screen.
const rowsStyles = css({
  maxBlockSize: "50cqh",
  overflowY: "auto",
  scrollbarColor: "{colors.border} transparent",
  scrollbarWidth: "thin",
  // Keeps a row scrolled by `keepInView` off the edge.
  scrollPaddingBlock: 1,
});

// Line breaks kept, so code and addresses keep their shape. The compositor
// cuts long copies short; this cuts them to four lines.
const copyStyles = css({
  flex: "1 1 auto",
  fontSize: "md",
  lineClamp: 4,
  minInlineSize: 0,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
});

// A copied image, at its own shape. Capped in width, so a wide image leaves
// room for its size beside it.
const pictureStyles = css({
  blockSize: 20,
  border: "1px solid color-mix(in oklab, {colors.foreground} 8%, transparent)",
  borderRadius: "sm",
  flexShrink: 0,
  maxInlineSize: "60%",
  objectFit: "contain",
});

// A group's name over its well.
const groupLabelStyles = css({
  color: "muted",
  fontSize: "xs",
  paddingInline: 3,
});

const groupStyles = vstack({
  alignItems: "stretch",
  gap: 1,
});

// The current copy, laid out as the rows below it but never lit.
const nowRowStyles = hstack({
  gap: 2.5,
  paddingBlock: 1.5,
  paddingInline: 2,
});

// Shown under the pointer or on focus, as the rows' button shows on the lit
// row.
const nowRemoveStyles = css({
  "div:hover > &": { opacity: 1 },
  opacity: { _focusWithin: 1, base: 0 },
  transition: "opacity {durations.fast} {easings.out}",
});
