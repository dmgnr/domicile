import { Button } from "@domicile-desktop/component-library/Button";
import { Input } from "@domicile-desktop/component-library/Input";
import { Kbd } from "@domicile-desktop/component-library/Kbd";
import { BroomIcon } from "@phosphor-icons/react/dist/ssr/Broom";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { useEffect, useRef } from "react";

import mark from "../icons/history.svg";
import { css } from "../styled-system/css";
import { flex, hstack } from "../styled-system/patterns";

type Props = {
  onClearData: () => void;
  onSearch: (text: string) => void;
  /** Whether the list has scrolled under the header. */
  scrolled: boolean;
  search: string;
};

/**
 * The title, the search box and "Clear browsing data". `/` and Ctrl+F focus
 * the search; Escape in it clears it.
 */
export const Header = ({ onClearData, onSearch, scrolled, search }: Props) => {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (isSearchKey(event)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => {
      window.removeEventListener("keydown", focusSearch);
    };
  }, []);
  return (
    <header className={headerStyles} data-scrolled={scrolled ? "" : undefined}>
      <div className={innerStyles}>
        <div className={titleRowStyles}>
          <img alt="" className={markStyles} src={mark} />
          <h1 className={titleStyles}>History</h1>
          <span className={spacerStyles} />
          <Button
            beforeIcon={<BroomIcon />}
            onClick={onClearData}
            rounded
            size="sm"
            variant="outline"
          >
            Clear browsing data
          </Button>
        </div>
        <div className={searchStyles}>
          <Input
            aria-label="Search history"
            clearable
            enterKeyHint="search"
            onChange={(event) => {
              onSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (search === "") {
                  event.currentTarget.blur();
                } else {
                  onSearch("");
                }
              }
            }}
            placeholder="Search history"
            prefixIcon={<MagnifyingGlassIcon />}
            ref={searchRef}
            role="searchbox"
            rounded
            size="lg"
            spellCheck={false}
            suffixIcon={search === "" ? <Kbd>/</Kbd> : undefined}
            value={search}
          />
        </div>
      </div>
    </header>
  );
};

/** `/` outside a text field, or Ctrl+F anywhere. */
const isSearchKey = (event: KeyboardEvent): boolean =>
  (event.key === "f" && (event.ctrlKey || event.metaKey)) ||
  (event.key === "/" &&
    !(event.target instanceof HTMLInputElement) &&
    !(event.target instanceof HTMLTextAreaElement));

// The shadow is on its own layer, which fades, so scrolling past the top
// repaints no shadow.
const headerStyles = css({
  _after: {
    boxShadow:
      "0 {spacing.2} {spacing.6} color-mix(in oklab, {colors.backdrop} 25%, transparent)",
    content: '""',
    inset: 0,
    opacity: 0,
    pointerEvents: "none",
    position: "absolute",
    transition: "opacity {durations.normal} {easings.out}",
  },
  "&[data-scrolled]": {
    _after: { opacity: 1 },
    backdropFilter: "blur({spacing.4}) saturate(160%)",
    backgroundColor:
      "color-mix(in oklab, {colors.background} 60%, transparent)",
    borderBlockEndColor:
      "color-mix(in oklab, {colors.foreground} 10%, transparent)",
  },
  backgroundColor: "transparent",
  borderBlockEnd: "1px solid transparent",
  flexShrink: 0,
  paddingBlockEnd: 5,
  paddingBlockStart: 8,
  paddingInline: 6,
  position: "relative",
  transition:
    "border-color {durations.normal} {easings.out}, background-color {durations.normal} {easings.out}",
  zIndex: 2,
});

const innerStyles = flex({
  direction: "column",
  gap: 5,
  marginInline: "auto",
  maxInlineSize: 200,
});

const titleRowStyles = hstack({ gap: 3.5 });

const markStyles = css({
  blockSize: 10,
  filter:
    "drop-shadow(0 {spacing.1} {spacing.3} color-mix(in oklab, {colors.accent} 35%, transparent))",
  inlineSize: 10,
});

const titleStyles = css({
  color: "foreground",
  fontSize: "3xl",
  fontWeight: "bold",
  letterSpacing: "tighter",
  lineHeight: "tight",
  margin: 0,
});

const spacerStyles = css({ flexGrow: 1 });

// A glow under the field while it has focus, on its own layer, which fades.
const searchStyles = css({
  _after: {
    borderRadius: "full",
    boxShadow:
      "0 0 0 {spacing.1} color-mix(in oklab, {colors.accent} 18%, transparent), 0 {spacing.3} {spacing.10} color-mix(in oklab, {colors.accent} 22%, transparent)",
    content: '""',
    inset: 0,
    opacity: 0,
    pointerEvents: "none",
    position: "absolute",
    transition: "opacity {durations.normal} {easings.out}",
  },
  "&:focus-within": { _after: { opacity: 1 } },
  borderRadius: "full",
  boxShadow: "{shadows.lifted}",
  position: "relative",
});
