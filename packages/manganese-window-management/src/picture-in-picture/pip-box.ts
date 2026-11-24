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

/**
 * `box` in a video's new `shape`, as when its page first says its size: as
 * wide as it was, as far as `workspace` allows, with its bottom-right corner
 * where it was.
 */
export const reshapedBox = (box: Rect, workspace: Rect, shape: Shape): Rect => {
  const ratio = ratioOf(shape);
  const width = Math.round(
    Math.min(box.width, workspace.width, workspace.height * ratio),
  );
  const height = Math.round(width / ratio);
  return movedBox(
    {
      height,
      width,
      x: box.x + box.width - width,
      y: box.y + box.height - height,
    },
    workspace,
    0,
    0,
  );
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

/**
 * Where a video is drawn on the desktop: its `source` box in the page drawn
 * at `page`, fitted to its `shape` as a `<video>` fits its frames.
 */
export const inPage = (page: Rect, source: Rect, shape: Shape): Rect => {
  const ratio = ratioOf(shape);
  const width = Math.min(source.width, source.height * ratio);
  const height = width / ratio;
  return {
    height,
    width,
    x: page.x + source.x + (source.width - width) / 2,
    y: page.y + source.y + (source.height - height) / 2,
  };
};

/** How far `box` moves and scales, about its top left, to lie on `to`. */
export type Offset = { scale: number; x: number; y: number };

/** The {@link Offset} from `box` to `to`, a box of its shape. */
export const offsetTo = (box: Rect, to: Rect): Offset => ({
  scale: to.width / box.width,
  x: to.x - box.x,
  y: to.y - box.y,
});
