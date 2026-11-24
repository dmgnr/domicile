import type { AppMenuEntry } from "@domicile-desktop/sdk/app-menu";
import { appMenu } from "@domicile-desktop/sdk/app-menu";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** An Electron app window's menu bar, as the app last set it. */
export type AppMenuBar = {
  entries: readonly AppMenuEntry[];
  /** Whether the app shows the bar at all (`setMenuBarVisibility`). */
  visible: boolean;
  /** Whether the bar hides until Alt is tapped (`autoHideMenuBar`). */
  autoHide: boolean;
};

/**
 * Browser window `engineId`'s menu bar, or `undefined` for a window with
 * none: any window but an Electron app's, or one whose app set no menu.
 */
export const useAppMenuBar = (
  domicile: Pick<Domicile, "browser">,
  engineId: string,
): AppMenuBar | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  const listed = () =>
    domicile.browser.windows?.find(({ id }) => id === engineId);
  // Three reads, each a string or a boolean, so each is stable between
  // changes as `useSyncExternalStore` needs.
  const menu = useSyncExternalStore(subscribe, () => listed()?.menu);
  const visible = useSyncExternalStore(
    subscribe,
    () => listed()?.menuBarVisible ?? true,
  );
  const autoHide = useSyncExternalStore(
    subscribe,
    () => listed()?.menuBarAutoHide ?? false,
  );
  const entries = useMemo(
    () => (menu === undefined ? undefined : appMenu(menu)),
    [menu],
  );
  return useMemo(
    () =>
      entries === undefined || entries.length === 0
        ? undefined
        : { autoHide, entries, visible },
    [autoHide, entries, visible],
  );
};
