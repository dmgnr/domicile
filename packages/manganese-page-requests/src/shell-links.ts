import { createContext } from "react";

/**
 * The links the shell opens itself, such as manganese's `mailto:` links,
 * which open in an inbox. A page's link for an application that the shell
 * opens goes to `open` rather than asking which application.
 */
export type ShellLinks = {
  /** Whether the shell opens `url` itself. */
  opens: (url: string) => boolean;
  open: (url: string) => void;
};

/** The shell's {@link ShellLinks}; none when it opens no links itself. */
export const ShellLinksContext = createContext<ShellLinks | undefined>(
  undefined,
);
