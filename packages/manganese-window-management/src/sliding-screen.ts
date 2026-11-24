// The screen a workspace switch slides a window across, handed from the
// window's wrapper to each of its parts so they clip themselves to their
// workspace with `clippedAlong`.

import { createContext } from "react";
import type { Rect } from "./rect";

/**
 * The screen a switch slides the window across, or `undefined` when none is.
 * Set by the window's wrapper from `slidingAcross`.
 */
export const SlidingScreen = createContext<Rect | undefined>(undefined);
