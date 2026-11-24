import type { Pointer } from "@domicile-desktop/sdk/desktop/pointer";
import type { Windows } from "@domicile-desktop/sdk/desktop/windows";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  confinementAsk,
  confinementBoxes,
  heldBoxes,
  heldKey,
} from "./pointer-confinement";
import type { Rect } from "./rect";

/** What confining the pointer for a window reads and asks of the desktop. */
export type ConfiningDesktop = {
  pointer: Pick<Pointer, "confine">;
  windows: Pick<Windows, "focused" | "list" | "on" | "pointerConstrained">;
};

/**
 * Confines the pointer to `appId`'s window, drawn at `rect`, while its client
 * asks and it has the keyboard (see {@link confinementAsk}), and follows the
 * window as it moves.
 *
 * The client hears it is confined once the engine has the boxes, and that it
 * is not once the shell lets go. Where the engine cannot hold the pointer,
 * nested or headless, the client still hears it, and its own motion is all
 * the confinement there is.
 */
export const usePointerConfinement = (
  { pointer, windows }: ConfiningDesktop,
  appId: string,
  rect: Rect | undefined,
  granted: boolean,
) => {
  const subscribe = useCallback(
    (changed: () => void) => {
      const stops = [
        windows.on("change", changed),
        windows.on("focuschange", changed),
      ];
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
    [windows],
  );
  const ask = useSyncExternalStore(subscribe, () =>
    confinementAsk(windows.list, windows.focused, appId),
  );
  const boxes =
    granted && ask !== undefined && rect !== undefined
      ? confinementBoxes(rect, ask)
      : [];
  // Keyed on the numbers, since `rect` is a new object on every render.
  const held = boxes.length === 0 ? undefined : heldKey(boxes);

  // Whether the client was told it is confined.
  const told = useRef(false);

  // The boxes go to the engine on every change; the first held tells the
  // client.
  useEffect(() => {
    if (held === undefined) {
      return undefined;
    }
    let current = true;
    pointer
      .confine(heldBoxes(held))
      .then(() => {
        if (current && !told.current) {
          told.current = true;
          windows.pointerConstrained(appId, true);
        }
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: surfacing a broken desktop call
        console.error(`The pointer was not confined to ${appId}`, error);
      });
    return () => {
      current = false;
    };
  }, [appId, held, pointer, windows]);

  // Letting go once the window stops asking, loses the keyboard or goes.
  const confining = held !== undefined;
  useEffect(() => {
    if (!confining) {
      return undefined;
    }
    return () => {
      pointer.confine([]).catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: surfacing a broken desktop call
        console.error(`The pointer confined to ${appId} was not let go`, error);
      });
      if (told.current) {
        told.current = false;
        windows.pointerConstrained(appId, false);
      }
    };
  }, [appId, confining, pointer, windows]);
};
