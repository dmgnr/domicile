import type { Box, ClientWindow } from "@domicile-desktop/sdk/desktop/windows";

import { z } from "zod";

import type { Rect } from "./rect";

/**
 * What a window that wants the pointer confined asked for: the part of it to
 * hold the pointer in, in its own coordinates, and its size, which scales
 * those to the page. A string, so React sees an unchanged ask as unchanged.
 */
export type ConfinementAsk = string;

const boxSchema = z.object({
  height: z.number(),
  width: z.number(),
  x: z.number(),
  y: z.number(),
});

const boxesSchema = z.array(boxSchema);

const askSchema = z.object({
  height: z.number().optional(),
  region: boxesSchema.optional(),
  width: z.number().optional(),
});

type Asked = z.infer<typeof askSchema>;

/**
 * `appId`'s ask to confine the pointer, while the shell should grant it: the
 * window has the keyboard and its client asked. `undefined` otherwise.
 *
 * Granted as {@link lockFor} grants a lock, and for its reasons: the
 * compositor offers a confinement only for the window under the pointer, and
 * moving the keyboard elsewhere is how the user takes the pointer back.
 */
export const confinementAsk = (
  list: readonly ClientWindow[],
  focused: string | undefined,
  appId: string,
): ConfinementAsk | undefined => {
  if (focused !== appId) {
    return undefined;
  }
  const window = list.find((listed) => listed.appId === appId);
  if (window?.pointerConstraint !== "confine") {
    return undefined;
  }
  const asked: Asked = {
    height: window.height,
    region: window.pointerRegion?.map(({ height, width, x, y }) => ({
      height,
      width,
      x,
      y,
    })),
    width: window.width,
  };
  return JSON.stringify(asked);
};

/**
 * The boxes in the page that hold the pointer for `ask`, a window drawn at
 * `rect`: its region scaled from the client's size to `rect`'s and clipped to
 * it, or all of `rect` for no region. Empty when no part of the region is
 * drawn, which confines to nowhere, so the shell does not take it.
 */
export const confinementBoxes = (
  rect: Rect,
  ask: ConfinementAsk,
): readonly Box[] => {
  const { height, region, width } = askSchema.parse(JSON.parse(ask));
  if (region === undefined) {
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }
  // A client that has not drawn has no size yet; its region is then in the
  // page's own pixels.
  const across = width === undefined || width === 0 ? 1 : rect.width / width;
  const down = height === undefined || height === 0 ? 1 : rect.height / height;
  return region.flatMap((box) => {
    const left = Math.max(rect.x, rect.x + box.x * across);
    const top = Math.max(rect.y, rect.y + box.y * down);
    const right = Math.min(
      rect.x + rect.width,
      rect.x + (box.x + box.width) * across,
    );
    const bottom = Math.min(
      rect.y + rect.height,
      rect.y + (box.y + box.height) * down,
    );
    return right > left && bottom > top
      ? [{ height: bottom - top, width: right - left, x: left, y: top }]
      : [];
  });
};

/**
 * `boxes` as a string, so React sees the same boxes as unchanged; read back
 * with {@link heldBoxes}.
 */
export const heldKey = (boxes: readonly Box[]): string => JSON.stringify(boxes);

/** The boxes {@link heldKey} wrote. */
export const heldBoxes = (key: string): readonly Box[] =>
  boxesSchema.parse(JSON.parse(key));
