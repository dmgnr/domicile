import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { MessageBox } from "@domicile-desktop/sdk/message-box";
import { messageBox } from "@domicile-desktop/sdk/message-box";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** The message box an Electron app window shows, and how to answer it. */
export type AppMessageBoxRequest = {
  box: MessageBox;
  /** The box as listed, which names it apart from the app's next one. */
  key: string;
  answer: (button: number, checked: boolean) => void;
};

/**
 * The message box browser window `engineId` shows, or `undefined` for none:
 * any window but an Electron app's, or one whose app asks nothing. The engine
 * lists one box at a time; answering it lists the app's next.
 */
export const useAppMessageBox = (
  domicile: Pick<Domicile, "browser">,
  engineId: string,
): AppMessageBoxRequest | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  // A string, so it is stable between changes as `useSyncExternalStore`
  // needs.
  const listed = useSyncExternalStore(
    subscribe,
    () =>
      domicile.browser.windows?.find(({ id }) => id === engineId)?.messageBox,
  );
  return useMemo(
    () =>
      listed === undefined
        ? undefined
        : {
            answer: (button, checked) => {
              domicile.browser.answerMessageBox(engineId, button, checked);
            },
            box: messageBox(listed),
            key: listed,
          },
    [domicile, engineId, listed],
  );
};
