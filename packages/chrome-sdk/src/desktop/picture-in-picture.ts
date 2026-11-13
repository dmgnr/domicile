// The videos pages put in picture-in-picture, which the shell floats. Show one
// with `<app picture-in-picture="id">`.

import type {
  DomicileHost,
  DomicilePictureInPictureAction,
  DomicilePictureInPictureVideo,
} from "../domicile-host";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";

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
  get videos() {
    return host.pictureInPictureVideos ?? NONE;
  },
});
