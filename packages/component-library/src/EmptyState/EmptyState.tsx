import type { Icon } from "@phosphor-icons/react";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import type { ReactNode } from "react";

import { css, cva } from "../../styled-system/css";
import "../stylesheet";

export const TONES = ["quiet", "warning"] as const;
export type Tone = (typeof TONES)[number];

export const LAYOUTS = ["panel", "inline"] as const;
export type Layout = (typeof LAYOUTS)[number];

type Props = {
  /**
   * What is missing, such as Wi-Fi's slashed fan for Wi-Fi turned off. A
   * `warning` without one shows a warning sign. `inline` draws none.
   */
  icon?: Icon | undefined;
  /** What is missing, in plain words: `Wi-Fi is off`. */
  title: string;
  /** What would fill it, in a short sentence. */
  hint?: string | undefined;
  /** A small button that would fill it, such as `Look again`. */
  action?: ReactNode;
  /**
   * `warning` for something that couldn't be read, tinted to say so. The
   * service's words go in `detail`.
   */
  tone?: Tone | undefined;
  /** The words behind a `warning`, such as a service's error, as a tooltip. */
  detail?: string | undefined;
  /**
   * `panel` centers it in the room a panel has, as tall as a `Loading` so
   * the panel holds still between them; `inline` is a faint caption under a
   * divider, below a panel's rows, such as nothing else nearby.
   */
  layout?: Layout | undefined;
};

/**
 * A panel or section with nothing to show, or that couldn't be read: an icon
 * on a tinted disc, what is missing, and what would fill it. Announced as it
 * changes.
 */
export const EmptyState = ({
  action,
  detail,
  hint,
  icon,
  layout = "panel",
  title,
  tone = "quiet",
}: Props) => {
  const Glyph = icon ?? WarningCircleIcon;
  return (
    <div
      className={rootStyles({ layout })}
      data-layout={layout}
      data-tone={tone}
      role="status"
      title={detail}
    >
      {layout === "panel" && (
        <span className={discStyles({ tone })}>
          <Glyph aria-hidden size={22} weight="bold" />
        </span>
      )}
      <span className={titleStyles({ layout })}>{title}</span>
      {hint !== undefined && <span className={hintStyles}>{hint}</span>}
      {action !== undefined && <span className={actionStyles}>{action}</span>}
    </div>
  );
};

const rootStyles = cva({
  base: {
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    textAlign: "center",
  },
  variants: {
    layout: {
      inline: {
        borderBlockStart: "1px solid {colors.divider}",
        color: "textFaint",
        gap: 0.5,
        paddingBlockStart: 2.5,
      },
      panel: {
        flex: 1,
        gap: 1.5,
        justifyContent: "center",
        // The same as `Loading`'s panel, so a panel holds still between them.
        minBlockSize: 40,
        paddingBlock: 5,
        paddingInline: 3,
      },
    },
  },
});

// The tone mixed into the panel's own fill, with a faint ring of it around
// the disc, so it reads on any surface.
const discStyles = cva({
  base: {
    "--tone": "{colors.accent}",
    alignItems: "center",
    backgroundImage:
      "linear-gradient(150deg, color-mix(in oklab, var(--tone) 32%, transparent), color-mix(in oklab, var(--tone) 12%, transparent))",
    blockSize: 12,
    borderRadius: "full",
    boxShadow:
      "inset 0 0 0 1px color-mix(in oklab, var(--tone) 30%, transparent)",
    color: "color-mix(in oklab, var(--tone) 70%, currentcolor)",
    display: "flex",
    flexShrink: 0,
    inlineSize: 12,
    justifyContent: "center",
    marginBlockEnd: 1.5,
    outline:
      "{spacing.1.5} solid color-mix(in oklab, var(--tone) 8%, transparent)",
  },
  variants: {
    tone: {
      quiet: {},
      warning: { "--tone": "{colors.warning}" },
    },
  },
});

// Inline, it is a caption under rows that matter more.
const titleStyles = cva({
  variants: {
    layout: {
      inline: { textStyle: "panelDetail" },
      panel: { textStyle: "panelLabel" },
    },
  },
});

// Narrower than a panel, and balanced, so a hint wraps to two even lines.
const hintStyles = css({
  color: "textSoft",
  maxInlineSize: "15rem",
  textStyle: "panelDetail",
  textWrap: "balance",
});

const actionStyles = css({ marginBlockStart: 1.5 });
