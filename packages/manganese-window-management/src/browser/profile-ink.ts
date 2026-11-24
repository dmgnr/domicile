/** The least contrast for bold text, as WCAG has it for large text. */
const MINIMUM_CONTRAST = 3;

/**
 * The text color on `color` (`#rrggbb`): white, as on the shell's own
 * colored buttons, unless that falls under 3:1 contrast, the least for bold
 * text, as on a light green; then black.
 */
export const inkOn = (color: string): "black" | "white" => {
  const channel = (at: number) => {
    const value = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05) < MINIMUM_CONTRAST ? "black" : "white";
};
