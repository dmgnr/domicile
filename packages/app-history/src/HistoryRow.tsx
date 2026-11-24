import { Button } from "@domicile-desktop/component-library/Button";
import type { Point } from "@domicile-desktop/component-library/ContextMenu";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/dist/ssr/DotsThreeVertical";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/ssr/GlobeSimple";
import type { CSSProperties, MouseEvent } from "react";
import { memo } from "react";

import { css } from "../styled-system/css";
import { timeOfDay } from "./day";
import { highlight } from "./highlight";
import type { Entry } from "./history-page";

type Props = {
  entry: Entry;
  /** Where the row sits in its day, which staggers its arrival. */
  index: number;
  leaving: boolean;
  /** Whether the row's menu is open, which keeps it highlighted. */
  menuOpen: boolean;
  /** When the row has finished leaving. */
  onLeft: (id: string) => void;
  onMenu: (entry: Entry, at: Point) => void;
  onOpenInNewWindow: (entry: Entry) => void;
  onToggle: (id: string, shift: boolean) => void;
  search: string;
  selected: boolean;
};

/**
 * One visited page: its time, icon, title and URL, linking to the page. A
 * page without an icon gets a globe.
 *
 * The icon is the row's check box. A click or middle-click opens the page in a
 * new window; a right click or the end button opens the row's menu.
 */
export const HistoryRow = memo(
  ({
    entry,
    index,
    leaving,
    menuOpen,
    onLeft,
    onMenu,
    onOpenInNewWindow,
    onToggle,
    search,
    selected,
  }: Props) => {
    const title = entry.title === "" ? entry.url : entry.title;
    const openElsewhere = (event: MouseEvent) => {
      event.preventDefault();
      onOpenInNewWindow(entry);
    };
    return (
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a right click opens the menu that the row's actions button opens from the keyboard
      <li
        className={rowStyles}
        data-entry-id={entry.id}
        data-leaving={leaving ? "" : undefined}
        data-selected={selected ? "" : undefined}
        onAnimationEnd={(event) => {
          if (leaving && event.target === event.currentTarget) {
            onLeft(entry.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(entry, { x: event.clientX, y: event.clientY });
        }}
        // Not a token: an index the arrival delay is multiplied by.
        style={{ "--row-index": Math.min(index, 12) } as CSSProperties}
      >
        <div
          className={innerStyles}
          data-menu-open={menuOpen ? "" : undefined}
          data-selected={selected ? "" : undefined}
        >
          <span className={timeStyles}>{timeOfDay(entry.time)}</span>
          <button
            aria-checked={selected}
            aria-label={`Select ${title}`}
            className={checkStyles}
            onClick={(event) => {
              onToggle(entry.id, event.shiftKey);
            }}
            role="checkbox"
            tabIndex={-1}
            type="button"
          >
            {entry.favicon === undefined ? (
              <GlobeSimpleIcon className={faviconStyles} data-favicon="" />
            ) : (
              <img
                alt=""
                className={faviconStyles}
                data-favicon=""
                draggable={false}
                src={entry.favicon}
              />
            )}
            <span className={tickStyles} data-tick="">
              <CheckIcon weight="bold" />
            </span>
          </button>
          <a
            className={linkStyles}
            data-row-link=""
            href={entry.url}
            onAuxClick={(event) => {
              if (event.button === 1) {
                openElsewhere(event);
              }
            }}
            onClick={openElsewhere}
          >
            <span className={titleStyles}>
              {highlight(title, search).map((segment, at) =>
                segment.marked ? (
                  <mark className={markStyles} key={at}>
                    {segment.text}
                  </mark>
                ) : (
                  segment.text
                ),
              )}
            </span>
            <span className={urlStyles}>{entry.url}</span>
          </a>
          <span className={actionsStyles} data-row-actions="">
            <Button
              label={`Actions for ${title}`}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                onMenu(entry, { x: box.left, y: box.bottom });
              }}
              size="sm"
              variant="ghost"
            >
              <DotsThreeVerticalIcon weight="bold" />
            </Button>
          </span>
        </div>
      </li>
    );
  },
);

// The row is a one-row grid so leaving can close its height smoothly.
const rowStyles = css({
  "&[data-leaving]": {
    animation: "rowLeave {durations.slow} {easings.in} forwards",
    pointerEvents: "none",
  },
  animation: "rise {durations.slow} {easings.outQuart} backwards",
  animationDelay: "calc(var(--row-index) * {durations.fastest} / 2)",
  display: "grid",
  gridTemplateRows: "1fr",
});

const innerStyles = css({
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 5%, transparent)",
  },
  "&:has([data-row-link]:focus-visible)": {
    boxShadow: "inset 0 0 0 {spacing.0.5} {colors.accent}",
  },
  "&[data-menu-open]": {
    backgroundColor: "color-mix(in oklab, {colors.foreground} 7%, transparent)",
  },
  "&[data-selected]": {
    backgroundColor: "color-mix(in oklab, {colors.accent} 14%, transparent)",
  },
  "&[data-selected]:hover": {
    backgroundColor: "color-mix(in oklab, {colors.accent} 20%, transparent)",
  },
  alignItems: "center",
  borderRadius: "lg",
  display: "flex",
  gap: 3,
  minBlockSize: 0,
  overflow: "hidden",
  paddingInline: 2,
  position: "relative",
  transition: "background-color {durations.fast} {easings.out}",
});

const timeStyles = css({
  color: "muted",
  flexShrink: 0,
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  inlineSize: 16,
  paddingInlineStart: 1,
  textAlign: "end",
});

// The favicon on a tile, which turns into a check box under the pointer and
// fills with the accent when checked. The ring round a checked one is its own
// layer, which fades.
const checkStyles = css({
  _after: {
    borderRadius: "inherit",
    boxShadow:
      "0 0 0 {spacing.1} color-mix(in oklab, {colors.accent} 22%, transparent)",
    content: '""',
    inset: "-1px",
    opacity: 0,
    pointerEvents: "none",
    position: "absolute",
    transition: "opacity {durations.normal} {easings.out}",
  },
  "&:hover [data-favicon], &[aria-checked=true] [data-favicon]": {
    opacity: 0,
    transform: "scale(0.6)",
  },
  "&:hover [data-tick]": {
    opacity: 0.35,
    transform: "scale(1)",
  },
  "&:hover, &[aria-checked=true]": {
    borderColor: "color-mix(in oklab, {colors.accent} 70%, transparent)",
  },
  "&[aria-checked=true]": {
    _after: { opacity: 1 },
    backgroundColor: "accent",
  },
  "&[aria-checked=true] [data-tick]": {
    color: "background",
    opacity: 1,
    transform: "scale(1)",
  },
  alignItems: "center",
  backgroundColor: "color-mix(in oklab, {colors.foreground} 6%, transparent)",
  blockSize: 8,
  border: "1px solid color-mix(in oklab, {colors.foreground} 8%, transparent)",
  borderRadius: "md",
  cursor: "pointer",
  display: "grid",
  flexShrink: 0,
  inlineSize: 8,
  justifyItems: "center",
  padding: 0,
  position: "relative",
  transition:
    "background-color {durations.fast} {easings.out}, border-color {durations.fast} {easings.out}",
});

const faviconStyles = css({
  blockSize: 4,
  color: "muted",
  gridArea: "1 / 1",
  inlineSize: 4,
  transition:
    "opacity {durations.fast} {easings.out}, transform {durations.normal} {easings.outBack}",
});

const tickStyles = css({
  color: "accent",
  display: "inline-flex",
  fontSize: "md",
  gridArea: "1 / 1",
  opacity: 0,
  transform: "scale(0.4)",
  transition:
    "opacity {durations.fast} {easings.out}, transform {durations.normal} {easings.outBack}",
});

const linkStyles = css({
  _focusVisible: { outlineStyle: "none" },
  // The whole row answers the pointer, but only the link is a target, so the
  // text stays selectable from the start of the row.
  alignItems: "baseline",
  color: "foreground",
  display: "flex",
  flexGrow: 1,
  gap: 2.5,
  minInlineSize: 0,
  paddingBlock: 2.5,
  textDecoration: "none",
});

const titleStyles = css({
  fontSize: "sm",
  fontWeight: "medium",
  minInlineSize: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const markStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.accent} 26%, transparent)",
  borderRadius: "xs",
  boxShadow: "0 0 0 1px color-mix(in oklab, {colors.accent} 26%, transparent)",
  color: "inherit",
});

const urlStyles = css({
  color: "muted",
  flexShrink: 0,
  fontSize: "xs",
  maxInlineSize: "40%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const actionsStyles = css({
  "[data-row-link]:focus-visible ~ &, &:focus-within, [data-selected] &, div:hover > &":
    {
      opacity: 1,
    },
  flexShrink: 0,
  opacity: 0,
  transition: "opacity {durations.fast} {easings.out}",
});
