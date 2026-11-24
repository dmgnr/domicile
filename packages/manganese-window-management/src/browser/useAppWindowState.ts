import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useSyncExternalStore,
} from "react";

/**
 * Keeps browser window `engineId` in step with what its Electron app asks
 * (`win.setFullScreen`), and tells the app what the window is.
 *
 * - Calls `onFullscreen` when the app asks for fullscreen or out of it, as a
 *   page's `requestFullscreen()` does through `usePageFullscreen`.
 * - Reports `fullscreen`, whether the window fills its screen, as it mounts
 *   and on each change. Windows tile, so none is ever maximized, and none is
 *   minimized.
 *
 * Any other window wants nothing, and ignores the report.
 */
export const useAppWindowState = (
  domicile: Pick<Domicile, "browser">,
  engineId: string,
  fullscreen: boolean,
  onFullscreen: (fullscreen: boolean) => void,
): void => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  const wantsFullscreen = useSyncExternalStore(
    subscribe,
    () =>
      domicile.browser.windows?.find(({ id }) => id === engineId)
        ?.wantsFullscreen ?? false,
  );

  // An effect event, so a new `onFullscreen` each render does not ask again.
  const ask = useEffectEvent((wants: boolean) => {
    onFullscreen(wants);
  });
  // Only a change asks: a window that wants nothing leaves the shell be.
  const wanted = useRef(false);
  useEffect(() => {
    if (wantsFullscreen !== wanted.current) {
      wanted.current = wantsFullscreen;
      ask(wantsFullscreen);
    }
  }, [wantsFullscreen]);

  useEffect(() => {
    domicile.browser.setWindowState(engineId, {
      fullscreen,
      maximized: false,
      minimized: false,
    });
  }, [domicile, engineId, fullscreen]);
};
