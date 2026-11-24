// The videos pages put in picture-in-picture, which the shell floats. Show one
// with `<app picture-in-picture="id">`.

import type {
  DomicileHost,
  DomicilePictureInPictureAction,
  DomicilePictureInPictureVideo,
} from "../domicile-host";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";

/**
 * Fired at an `<app picture-in-picture>` once it embeds its video's first
 * surface, so it draws the video from the next frame. Show the element, or
 * start its motion, from here rather than over an empty box.
 */
export const PICTURE_IN_PICTURE_SHOWN_EVENT =
  "domicile-picture-in-picture-shown";

export type PictureInPictureListeners = {
  /** {@link PictureInPicture.videos} changed. */
  change: () => void;
};

export type PictureInPicture = {
  /**
   * The videos in picture-in-picture, oldest first. The same list until
   * `change`.
   */
  readonly videos: readonly DomicilePictureInPictureVideo[];
  /** Act on video `id` as its controls do. */
  act: (id: string, action: DomicilePictureInPictureAction) => void;
  /** Move video `id` to `seconds` in, as its progress bar does. */
  seek: (id: string, seconds: number) => void;
  /** Say video `id` is shown `width` by `height` CSS pixels big. */
  resize: (id: string, width: number, height: number) => void;
  on: On<PictureInPictureListeners>;
};

export type PictureInPictureHost = Pick<
  DomicileHost,
  | "actOnPictureInPictureVideo"
  | "addEventListener"
  | "pictureInPictureVideos"
  | "removeEventListener"
  | "resizePictureInPictureVideo"
  | "seekPictureInPictureVideo"
>;

/** The list before the browser says, the same each read. */
const NONE: readonly DomicilePictureInPictureVideo[] = [];

export const pictureInPicture = (
  host: PictureInPictureHost,
): PictureInPicture => ({
  act: (id, action) => {
    host.actOnPictureInPictureVideo(id, action);
  },
  on: on<PictureInPictureListeners>({
    change: (listener) =>
      hostEvent(host, "pictureinpicturevideoschanged", () => listener()),
  }),
  resize: (id, width, height) => {
    host.resizePictureInPictureVideo(id, width, height);
  },
  seek: (id, seconds) => {
    host.seekPictureInPictureVideo(id, seconds);
  },
  get videos() {
    return host.pictureInPictureVideos ?? NONE;
  },
});
