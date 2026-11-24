import type { AppPopupMenu } from "@domicile-desktop/sdk/app-menu";
import { appPopupMenu } from "@domicile-desktop/sdk/app-menu";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** The popup menu an Electron app window shows, and how to answer it. */
export type AppPopupMenuRequest = {
  popup: AppPopupMenu;
  /** The menu as listed, which names it apart from the app's next one. */
  key: string;
  /** The entry chosen, or 0 for none. */
  answer: (command: number) => void;
};

/**
 * The popup menu browser window `engineId`'s app shows (`Menu.popup`), or
 * `undefined` for none. The engine lists one at a time; a newer one replaces
 * it.
 */
export const useAppPopupMenu = (
  domicile: Pick<Domicile, "browser">,
  engineId: string,
): AppPopupMenuRequest | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  // A string, so it is stable between changes as `useSyncExternalStore`
  // needs.
  const listed = useSyncExternalStore(
    subscribe,
    () =>
      domicile.browser.windows?.find(({ id }) => id === engineId)?.popupMenu ??
      undefined,
  );
  return useMemo(
    () =>
      listed === undefined
        ? undefined
        : {
            answer: (command) => {
              domicile.browser.answerPopupMenu(engineId, command);
            },
            key: listed,
            popup: appPopupMenu(listed),
          },
    [domicile, engineId, listed],
  );
};
