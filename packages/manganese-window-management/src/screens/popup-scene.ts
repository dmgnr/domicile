import { windowsIn } from "../tree/node";
import type { WindowState } from "../window-state";
import type { StageScreen } from "./stage-screens";

/**
 * What the desk shows, as a key for the component library's `PopupScene`.
 * Popups close when it changes, since each part moves or covers the windows
 * and bars they point at:
 *
 * - the overview, launcher or clipboard opening or closing,
 * - a screen switching workspace,
 * - a window going fullscreen or leaving it,
 * - a scratchpad window showing or hiding.
 *
 * A window moving or resizing closes only its own popups, through its
 * `PopupBoundary`.
 */
export const popupSceneOf = (
  {
    clipboardOpen,
    launcherOpen,
    overviewOpen,
  }: Pick<WindowState, "clipboardOpen" | "launcherOpen" | "overviewOpen">,
  screens: readonly StageScreen[],
): string =>
  JSON.stringify([
    clipboardOpen,
    launcherOpen,
    overviewOpen,
    screens.map(({ current, floats, fullscreen, geometry }) => [
      geometry.name,
      current,
      fullscreen?.windows ?? [],
      floats
        .filter(({ scratchpad }) => scratchpad)
        .flatMap(({ root }) => windowsIn(root)),
    ]),
  ]);
