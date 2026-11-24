import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { circle, hstack } from "../../styled-system/patterns";
import "../stylesheet";

type Props = {
  /**
   * How many times the level changed. A new count keeps the toast up for
   * another full hold, or shows it again once it has gone.
   */
  changes: number;
  /** Drawn large before the label. */
  icon: ReactNode;
  /** What the level is of, such as "Volume". */
  label: string;
  /** From 0 to 1. */
  level: number;
  /** Says "Muted" and grays the meter, such as for muted audio. */
  muted: boolean;
};

/**
 * A large toast showing a level, such as volume or brightness, that fades out
 * a moment after its last change.
 *
 * A change while it is up updates it in place and starts the hold over, so
 * holding a key does not replay its entrance. It hides on its own
 * `animationend`, not a timer, so the duration lives only in the stylesheet.
 * The caller positions it; it ignores the pointer.
 */
export const LevelToast = ({ changes, icon, label, level, muted }: Props) => (
  <HeldToast
    changes={changes}
    icon={icon}
    label={label}
    muted={muted}
    value={muted ? "Muted" : `${String(Math.round(level * 100))}%`}
  >
    <span
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(level * 100)}
      className={meterStyles}
      data-muted={muted ? "" : undefined}
      role="meter"
      // Inline because the level is a runtime value Panda cannot extract.
      style={{ "--level-toast-level": level } as CSSProperties}
    >
      <span className={fillStyles} />
    </span>
  </HeldToast>
);

type ChoiceProps = Pick<Props, "changes" | "icon" | "label"> & {
  /** What was chosen, such as a keymap's name. */
  choice: string;
  /** A line under the label saying more of it, if any. */
  detail?: string | undefined;
};

/**
 * A toast like {@link LevelToast} naming a choice just made, such as the
 * keymap a key switched to, with no meter.
 */
export const ChoiceToast = ({
  changes,
  choice,
  detail,
  icon,
  label,
}: ChoiceProps) => (
  <HeldToast
    changes={changes}
    icon={icon}
    label={label}
    muted={false}
    value={choice}
  >
    {detail !== undefined && <span className={detailStyles}>{detail}</span>}
  </HeldToast>
);

/** The held, fading card both toasts are, with `children` under the label. */
const HeldToast = ({
  changes,
  children,
  icon,
  label,
  muted,
  value,
}: Omit<Props, "level"> & { children?: ReactNode; value: string }) => {
  const [goneAfter, setGoneAfter] = useState<number | undefined>();

  return goneAfter === changes ? undefined : (
    <output
      className={toastStyles}
      // Alternates the fade-out between two copies of one keyframe, so the
      // browser restarts it while the entrance, unchanged, does not replay.
      data-again={changes % 2 === 0 ? "" : undefined}
      data-muted={muted ? "" : undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) {
          setGoneAfter(changes);
        }
      }}
    >
      <span className={panelStyles}>
        <span className={iconStyles}>{icon}</span>
        <span className={readoutStyles}>
          <span className={labelRowStyles}>
            <span>{label}</span>
            <span className={valueStyles}>{value}</span>
          </span>
          {children}
        </span>
      </span>
    </output>
  );
};

// Holds, then fades the whole toast out.
const toastStyles = css({
  "&[data-again]": {
    animationName: "levelToastHoldAgain",
  },
  animation: "levelToastHold {durations.levelToast} {easings.linear} forwards",
  display: "block",
  pointerEvents: "none",
});

// Rises in once per showing. A frosted card like `Toaster`'s.
const panelStyles = hstack({
  animation: "levelToastEnter {durations.normal} {easings.outQuart}",
  backdropFilter: "blur({spacing.4}) saturate(160%)",
  backgroundColor: "color-mix(in oklab, {colors.card} 85%, transparent)",
  border: "1px solid color-mix(in oklab, {colors.foreground} 12%, transparent)",
  borderRadius: "3xl",
  boxShadow: "lifted",
  color: "foreground",
  gap: 4,
  inlineSize: 88,
  paddingBlock: 4,
  paddingInline: 5,
});

const iconStyles = circle({
  "[data-muted] &": {
    backgroundColor:
      "color-mix(in oklab, {colors.foreground} 10%, transparent)",
    color: "muted",
  },
  backgroundColor: "color-mix(in oklab, {colors.accent} 18%, transparent)",
  color: "accent",
  flexShrink: 0,
  size: 12,
  transition:
    "color {durations.fast} {easings.out}, background-color {durations.fast} {easings.out}",
});

const readoutStyles = css({
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: 0.5,
  minInlineSize: 0,
});

const labelRowStyles = hstack({
  fontSize: "md",
  fontWeight: "medium",
  justify: "space-between",
});

const valueStyles = css({
  fontVariantNumeric: "tabular-nums",
  fontWeight: "semibold",
});

// A track filled from the start edge. The fill eases to each new level, which
// shows while a key is held.
const meterStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.foreground} 14%, transparent)",
  blockSize: 2,
  borderRadius: "full",
  marginBlockStart: 2,
  overflow: "hidden",
});

// The whole track's width, slid in from the start and clipped by it, so a new
// level skips layout. `translateX` is physical: a transform takes no logical
// direction.
const fillStyles = css({
  "[data-muted] > &": {
    backgroundColor: "muted",
  },
  backgroundColor: "accent",
  blockSize: "100%",
  borderRadius: "full",
  display: "block",
  inlineSize: "100%",
  transform: "translateX(calc((var(--level-toast-level) - 1) * 100%))",
  transition:
    "transform {durations.fast} {easings.out}, background-color {durations.fast} {easings.out}",
});

const detailStyles = css({
  color: "muted",
  fontSize: "sm",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
