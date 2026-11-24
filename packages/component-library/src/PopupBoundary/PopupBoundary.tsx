import type { ReactNode, RefCallback } from "react";
import { createContext, useCallback, useContext, useState } from "react";
import { PopupScene } from "../PopupScene/PopupScene";
import "../stylesheet";

/** A box in page pixels. */
export type Box = { height: number; width: number; x: number; y: number };

type Props = {
  /** The box popups inside stay within, such as a window's frame. */
  box: Box | undefined;
  children: ReactNode;
};

/**
 * Keeps every popup opened inside it within `box`: tooltips, popovers, menus
 * and lists. A shell wraps each window in one, so a popup never spans two
 * windows. Outside any, a popup stays on its trigger's `<Screen>` region.
 *
 * The innermost one wins. A popup passed `spansWindows` leaves it for its
 * trigger's screen.
 *
 * Popups inside close when `box` moves or resizes, since what they point at
 * moved with it. See `PopupScene`.
 */
export const PopupBoundary = ({ box, children }: Props) => (
  <PopupScene scene={JSON.stringify(box ?? null)}>
    <Bounds value={box}>{children}</Bounds>
  </PopupScene>
);

const Bounds = createContext<Box | undefined>(undefined);

/**
 * Where a popup stays: the nearest `PopupBoundary`, else its trigger's
 * `<Screen>` region, else the viewport. `spansWindows` skips the
 * `PopupBoundary`.
 *
 * `attach` takes the trigger, from a ref or from whichever trigger opened the
 * popup.
 */
export const usePopupBoundary = (
  spansWindows: boolean,
): {
  attach: (trigger: Element | null) => void;
  boundary: Box | Element | undefined;
} => {
  const box = useContext(Bounds);
  const [screen, setScreen] = useState<Element | undefined>(undefined);
  const attach = useCallback<RefCallback<Element>>((trigger) => {
    setScreen(trigger?.closest("[data-screen]") ?? undefined);
  }, []);
  return {
    attach,
    boundary: box === undefined || spansWindows ? screen : box,
  };
};
