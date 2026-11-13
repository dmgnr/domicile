// Where a video in picture-in-picture floats: its box on its screen's
// workspace, in desktop pixels, always in the video's shape.

import { isForward } from "../direction";
import type { Grip } from "../floating/float";
import type { Rect } from "../rect";

/** A video's own size, whose shape its box keeps. */
export type Shape = { height: number; width: number };

/** How far a new video sits from the workspace's bottom and right edges. */
const MARGIN = 24;

/** The share of the workspace's width a new video takes, at most {@link OPENS_WIDEST}. */
const OPENS_AT = 0.25;
const OPENS_WIDEST = 480;

/** The narrowest a video is resized to, where its controls still fit. */
const NARROWEST = 240;

/** Width over height; square while the video has no size yet. */
const ratioOf = ({ height, width }: Shape): number =>
  height > 0 && width > 0 ? width / height : 1;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** A new video's box: small, in the bottom-right corner of `workspace`. */
export const openingBox = (workspace: Rect, shape: Shape): Rect => {
  const width = Math.min(
    clamp(workspace.width * OPENS_AT, NARROWEST, OPENS_WIDEST),
    workspace.width - 2 * MARGIN,
  );
  const height = Math.round(width / ratioOf(shape));
  return {
    height,
    width,
    x: workspace.x + workspace.width - MARGIN - width,
    y: workspace.y + workspace.height - MARGIN - height,
  };
};

/** `box` dragged by (`dx`, `dy`), kept on `workspace`. */
export const movedBox = (
  box: Rect,
  workspace: Rect,
  dx: number,
  dy: number,
): Rect => ({
  ...box,
  x: clamp(box.x + dx, workspace.x, workspace.x + workspace.width - box.width),
  y: clamp(
    box.y + dy,
    workspace.y,
    workspace.y + workspace.height - box.height,
  ),
});

/**
 * `box` resized by dragging the edges `grip` names by (`dx`, `dy`), in
 * `shape`. The edges opposite stay put; a corner follows whichever of its
 * edges grew it more.
 */
export const resizedBox = (
  box: Rect,
  workspace: Rect,
  shape: Shape,
  { horizontal, vertical }: Grip,
  dx: number,
  dy: number,
): Rect => {
  const ratio = ratioOf(shape);
  const across =
    horizontal === undefined
      ? undefined
      : box.width + (isForward(horizontal) ? dx : -dx);
  const down =
    vertical === undefined
      ? undefined
      : (box.height + (isForward(vertical) ? dy : -dy)) * ratio;
  const wanted = Math.max(
    across ?? Number.NEGATIVE_INFINITY,
    down ?? Number.NEGATIVE_INFINITY,
  );
  const width = Math.round(
    clamp(
      wanted,
      NARROWEST,
      Math.min(workspace.width, workspace.height * ratio),
    ),
  );
  const height = Math.round(width / ratio);
  const resized = {
    height,
    width,
    x:
      horizontal !== undefined && !isForward(horizontal)
        ? box.x + box.width - width
        : box.x,
    y:
      vertical !== undefined && !isForward(vertical)
        ? box.y + box.height - height
        : box.y,
  };
  return movedBox(resized, workspace, 0, 0);
};
