import { useState } from "react";

import { css } from "../styled-system/css";
import { circle } from "../styled-system/patterns";

type Props = {
  name: string;
  /** Its manifest icon as a `data:` URL, or none when it has none. */
  icon: string | undefined;
  size: "sm" | "md";
};

/**
 * An extension's own icon, as chrome://extensions draws it, or its initial
 * when it has none or the icon won't load.
 */
export const ExtensionIcon = ({ icon, name, size }: Props) => {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  return icon === undefined || failed === icon ? (
    <span aria-hidden className={initialStyles[size]}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is the image failing to load, not a user's interaction
    <img
      alt=""
      className={imageStyles[size]}
      onError={() => {
        setFailed(icon);
      }}
      src={icon}
    />
  );
};

const initialStyles = {
  md: circle({
    backgroundColor: "color-mix(in oklab, {colors.accent} 22%, {colors.card})",
    color: "accent",
    flexShrink: 0,
    fontSize: "sm",
    fontWeight: "semibold",
    size: 9,
  }),
  sm: circle({
    backgroundColor: "color-mix(in oklab, {colors.accent} 22%, {colors.card})",
    color: "accent",
    flexShrink: 0,
    fontSize: "xs",
    fontWeight: "semibold",
    size: 6,
  }),
};

const imageStyles = {
  md: css({ blockSize: 9, flexShrink: 0, inlineSize: 9, objectFit: "contain" }),
  sm: css({ blockSize: 6, flexShrink: 0, inlineSize: 6, objectFit: "contain" }),
};
