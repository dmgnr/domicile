// Where a browser window's page is drawn, for a video in picture-in-picture
// to grow out of and shrink back into.

import type { Rect } from "../rect";

/**
 * Where browser window `window`'s `<webview>` is drawn on the desktop, or
 * undefined while it is drawn nowhere: hidden, as on another workspace or
 * behind another tab, or no window at all.
 */
export const pageOf = (
  document: Document,
  window: string,
): Rect | undefined => {
  const view =
    window === ""
      ? null
      : document.querySelector(`webview[window="${CSS.escape(window)}"]`);
  if (view === null || !view.checkVisibility()) {
    return undefined;
  } else {
    const { height, width, x, y } = view.getBoundingClientRect();
    return { height, width, x, y };
  }
};
