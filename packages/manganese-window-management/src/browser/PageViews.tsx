import type { BrowserWindow } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { WEBVIEW_GUEST_FOCUS_EVENT } from "@domicile-desktop/sdk/webview-element";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { css } from "../../styled-system/css";

type Props = {
  domicile: Pick<Domicile, "browser">;
  /** A click in a view's page: see `BrowserWindow`'s `onReach`. */
  onReach: () => void;
  /** Nothing can click the window, so a view taking focus is no reach. */
  unclickable: boolean;
  /** The engine id of the window whose views these are. */
  window: string;
};

/**
 * An Electron app's views (`WebContentsView`, `BrowserView`) in its window:
 * each a `<webview>` over the window's page, where the app put it, bottom
 * first. Manganese honors the app's layout; the engine's bounds are a hint
 * another shell may lay out its own way. See "Views" in
 * docs/SHELL-BROWSER-WINDOWS.md.
 */
export const PageViews = ({
  domicile,
  onReach,
  unclickable,
  window,
}: Props) => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  // The SDK keeps the same list until the engine's changes, so this settles.
  const all = useSyncExternalStore(subscribe, () => domicile.browser.views);
  const views = useMemo(
    () => all?.filter(({ parent }) => parent === window) ?? [],
    [all, window],
  );
  return views.map((view) => (
    <PageView
      key={view.id}
      onReach={onReach}
      unclickable={unclickable}
      view={view}
    />
  ));
};

const PageView = ({
  onReach,
  unclickable,
  view,
}: Omit<Props, "domicile" | "window"> & { view: BrowserWindow }) => {
  const [element, setElement] = useState<HTMLWebViewElement | null>(null);

  useEffect(() => {
    if (element === null) {
      return undefined;
    } else {
      const reached = () => {
        if (!unclickable) {
          onReach();
        }
      };
      element.addEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reached);
      return () => {
        element.removeEventListener(WEBVIEW_GUEST_FOCUS_EVENT, reached);
      };
    }
  }, [element, onReach, unclickable]);

  return (
    <webview
      className={viewStyles}
      ref={setElement}
      style={{
        blockSize: view.height,
        inlineSize: view.width,
        insetBlockStart: view.y,
        insetInlineStart: view.x,
        // Hidden, not removed: the page stays, as the app's hidden view does.
        visibility: view.isHidden ? "hidden" : undefined,
      }}
      // Read once, at insertion. The key keeps one element per view.
      window={view.id}
    />
  );
};

// The app's bounds are in the page's CSS pixels, from its top left corner.
const viewStyles = css({
  borderStyle: "none",
  position: "absolute",
});
