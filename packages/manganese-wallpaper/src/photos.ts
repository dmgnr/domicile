/// <reference path="./image.d.ts" />
// The built-in wallpaper photographs for each theme, served by Wikimedia
// Commons.
//
// - `Special:FilePath` serves a fixed file by title and `?width=` scales it,
//   so each URL is stable and cacheable.
// - The titles are in `commons-titles.ts`. All are public domain or CC0, so
//   no credit line is needed.
// - Remote URLs keep large JPEGs out of the repo. One small photograph per
//   theme ships in the repo and shows until a remote one loads.
//
// See `packages/manganese-wallpaper/docs/WALLPAPER.md`.

import type { Theme } from "@domicile-desktop/component-library/theme-core";

import { COMMONS_TITLES } from "./commons-titles";
import fallbackDark from "./fallback-dark.jpg";
import fallbackLight from "./fallback-light.jpg";

/**
 * The widths Commons serves a scaled photograph at that a screen can use, up
 * to 4K. Commons rounds any other width up to the next of these.
 */
const COMMONS_WIDTHS: readonly number[] = [1920, 3840];

/**
 * Requested width in `src`: 4K, the largest a screen uses. {@link sourceSet}
 * offers the smaller ones.
 */
const PHOTO_WIDTH = 3840;

/** Where Commons serves its files by title. */
const FILE_PATH = "https://commons.wikimedia.org/wiki/Special:FilePath/";

/**
 * The Commons URL for the file `title` at {@link PHOTO_WIDTH}, such as
 * `commonsPhoto("Andromeda galaxy 2023.jpg")`.
 *
 * Defined before {@link DEFAULT_WALLPAPERS}, which calls it at module load.
 */
export const commonsPhoto = (title: string): string =>
  commonsFile(encodeURIComponent(title), PHOTO_WIDTH);

const commonsFile = (encodedTitle: string, width: number): string =>
  `${FILE_PATH}${encodedTitle}?width=${width.toString()}`;

/**
 * An `<img srcset>` for `src` when it is a {@link commonsPhoto}: the
 * photograph at each width Commons serves, so the engine fetches and decodes
 * the smallest that covers the screen. A 4K photograph decoded for a 1080p
 * screen holds four times the memory it shows. `undefined` for any other
 * address, which has one file.
 */
export const sourceSet = (src: string): string | undefined => {
  const match = COMMONS_PHOTO.exec(src);
  const title = match?.[1];
  return title === undefined
    ? undefined
    : COMMONS_WIDTHS.map(
        (width) => `${commonsFile(title, width)} ${width.toString()}w`,
      ).join(", ");
};

/** A {@link commonsPhoto} address; the group is the encoded title. */
const COMMONS_PHOTO = new RegExp(
  `^${FILE_PATH.replaceAll(".", "\\.")}([^?]+)\\?width=${PHOTO_WIDTH.toString()}$`,
);

/**
 * The widest photographs are this shape. One covering a screen of another
 * shape is cropped, so it shows wider than the screen when the screen is
 * taller than this.
 */
const WIDEST_PHOTO = 16 / 9;

/**
 * An `<img sizes>` for a photograph covering a screen of `size`, in page
 * pixels: wide enough to cover it at any shape the photographs come in. The
 * whole page before the screens are known.
 */
export const photoSizes = (
  size: readonly [width: number, height: number] | undefined,
): string =>
  size === undefined
    ? "100vw"
    : `${Math.ceil(Math.max(size[0], size[1] * WIDEST_PHOTO)).toString()}px`;

/** Each theme's built-in photographs, used where the config sets none. */
export const DEFAULT_WALLPAPERS: Readonly<Record<Theme, readonly string[]>> = {
  dark: COMMONS_TITLES.dark.map(commonsPhoto),
  light: COMMONS_TITLES.light.map(commonsPhoto),
};

/** Each theme's photograph from the repository, shown until one loads. */
export const WALLPAPER_FALLBACKS: Record<Theme, string> = {
  dark: fallbackDark,
  light: fallbackLight,
};
