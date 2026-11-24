import { useState } from "react";

import { cva } from "../styled-system/css";

type Props = {
  /** Names the well, as it has no text. */
  label: string;
  /** The color, `#rrggbb`; none when unset. */
  value: string | undefined;
  /** What the well shows while `value` is unset. */
  unsetShownAs?: string | undefined;
  disabled: boolean;
  onCommit: (color: string) => void;
  /**
   * `square` is a well on its own, as the accent color; `round` ends a row
   * of swatches, picked when its color is none of theirs.
   */
  shape?: "round" | "square" | undefined;
  /**
   * Shows a rainbow in place of the color: a round well beside the swatch
   * that is picked, offering any other color.
   */
  rainbow?: boolean | undefined;
};

/**
 * A color well that opens the color picker for any color, and changes the
 * setting once the picker closes, not on every color the pointer passes.
 */
export const ColorWell = ({
  disabled,
  label,
  onCommit,
  rainbow = false,
  shape = "square",
  unsetShownAs = "#808080",
  value,
}: Props) => {
  const [draft, setDraft] = useState(value ?? unsetShownAs);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setDraft(value ?? unsetShownAs);
  }
  return (
    <input
      aria-label={label}
      className={wellStyles({ rainbow, shape })}
      disabled={disabled}
      onBlur={() => {
        if (draft !== (value ?? unsetShownAs)) {
          onCommit(draft);
        }
      }}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      type="color"
      value={draft}
    />
  );
};

const wellStyles = cva({
  base: {
    backgroundColor: "transparent",
    cursor: { _disabled: "not-allowed", base: "pointer" },
  },
  compoundVariants: [
    {
      css: {
        boxShadow: "0 0 0 2px {colors.card}, 0 0 0 4px {colors.foreground}",
      },
      rainbow: false,
      shape: "round",
    },
  ],
  variants: {
    rainbow: {
      false: {},
      true: {
        "&::-webkit-color-swatch": { opacity: 0 },
        background:
          "conic-gradient(#ef4444, #f59e0b, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)",
      },
    },
    shape: {
      round: {
        _disabled: { opacity: 0.6 },
        "&::-webkit-color-swatch": { border: "none", borderRadius: "full" },
        "&::-webkit-color-swatch-wrapper": { padding: 0 },
        border: "none",
        borderRadius: "full",
        padding: 0,
        size: 5,
      },
      square: {
        blockSize: 8,
        border: "1px solid {colors.border}",
        borderRadius: "md",
        inlineSize: 12,
        padding: 0.5,
      },
    },
  },
});
