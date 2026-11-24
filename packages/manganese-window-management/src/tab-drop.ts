// What a drag dropped on a tab strip opens in a new tab.
//
// A page can read a drag's data only at the drop, so while it is held over
// the strip only its types say what it will do.

import { typedAddress } from "@domicile-desktop/manganese-address/typed-address";

/** What a drop on a tab strip opens. */
export enum TabDropKind {
  /** Text, searched or opened as an address. */
  Search,
  /** A link's address. */
  Link,
  /** An image's address. */
  Image,
}

/**
 * What a drag carrying `types` (`DataTransfer.types`) opens, or `undefined`
 * when it carries nothing to open.
 */
export const tabDropKindOf = (
  types: readonly string[],
): TabDropKind | undefined => {
  if (types.includes("text/uri-list")) {
    return types.includes("Files") ? TabDropKind.Image : TabDropKind.Link;
  } else if (types.includes("text/plain")) {
    return TabDropKind.Search;
  } else {
    return undefined;
  }
};

/**
 * The address a drop opens: the first in `uriList`, else `text` as the
 * address bar reads it. `undefined` for blank text.
 */
export const droppedUrl = (uriList: string, text: string): string | undefined =>
  uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#")) ??
  typedAddress(text)?.url;
