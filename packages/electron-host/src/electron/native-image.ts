// The stand-in for Electron's `nativeImage`: a picture held as its PNG or JPEG
// bytes. PNGs are read and written by src/png.ts for a resize, a crop or a
// bitmap; a JPEG is kept as it came, since the host has no JPEG decoder.

import { readFileSync } from "node:fs";

import type { Bitmap } from "../png";
import { decodePng, encodePng, pngSize } from "../png";

type Size = { width: number; height: number };
type Rectangle = Size & { x: number; y: number };

/** What an image holds. */
type Picture =
  | { readonly kind: "empty" }
  | { readonly kind: "png"; readonly bytes: Uint8Array; readonly size: Size }
  | { readonly kind: "jpeg"; readonly bytes: Uint8Array; readonly size: Size };

const EMPTY: Picture = { kind: "empty" };

/** A JPEG's size, from its first frame header, or undefined for something else. */
const jpegSize = (bytes: Uint8Array): Size | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    // Start of frame: baseline, extended, progressive or lossless, not DHT,
    // JPG or DAC.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0),
        width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0),
      };
    }
    at += 2 + length;
  }
  return undefined;
};

/** Reads an encoded picture: a PNG or a JPEG. */
const pictureOf = (bytes: Uint8Array): Picture => {
  const png = pngSize(bytes);
  const jpeg = png === undefined ? jpegSize(bytes) : undefined;
  if (png !== undefined) {
    return { bytes, kind: "png", size: png };
  } else if (jpeg === undefined) {
    throw new Error(
      "this image is neither a PNG nor a JPEG, the kinds nativeImage reads on Domicile",
    );
  } else {
    return { bytes, kind: "jpeg", size: jpeg };
  }
};

/** Swaps red and blue: RGBA to BGRA and back. */
const swapRedBlue = (pixels: Uint8Array) => {
  const out = new Uint8Array(pixels);
  for (let at = 0; at < out.length; at += 4) {
    out[at] = pixels[at + 2] ?? 0;
    out[at + 2] = pixels[at] ?? 0;
  }
  return out;
};

/** `bitmap` scaled to `width` by `height`, sampling between pixels. */
const scale = (bitmap: Bitmap, width: number, height: number): Bitmap => {
  const rgba = new Uint8Array(width * height * 4);
  const clamp = (value: number, most: number) =>
    Math.min(Math.max(value, 0), most);
  for (let y = 0; y < height; y += 1) {
    const fromY = clamp(
      ((y + 0.5) * bitmap.height) / height - 0.5,
      bitmap.height - 1,
    );
    const y0 = Math.floor(fromY);
    const y1 = Math.min(y0 + 1, bitmap.height - 1);
    for (let x = 0; x < width; x += 1) {
      const fromX = clamp(
        ((x + 0.5) * bitmap.width) / width - 0.5,
        bitmap.width - 1,
      );
      const x0 = Math.floor(fromX);
      const x1 = Math.min(x0 + 1, bitmap.width - 1);
      for (let channel = 0; channel < 4; channel += 1) {
        const at = (column: number, row: number) =>
          bitmap.rgba[(row * bitmap.width + column) * 4 + channel] ?? 0;
        const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (fromX - x0);
        const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (fromX - x0);
        rgba[(y * width + x) * 4 + channel] = Math.round(
          top + (bottom - top) * (fromY - y0),
        );
      }
    }
  }
  return { height, rgba, width };
};

/** Electron's `NativeImage`: a picture for each scale factor it has. */
export class NativeImage {
  readonly #pictures = new Map<number, Picture>();

  constructor(picture: Picture) {
    if (picture.kind !== "empty") {
      this.#pictures.set(1, picture);
    }
  }

  readonly isEmpty = () => this.#pictures.size === 0;

  /**
   * In pixels, the picture closest to `scaleFactor`; without one, in DIPs,
   * as the picture closest to 1 shows.
   */
  readonly getSize = (scaleFactor?: number): Size => {
    const closest = this.#closest(scaleFactor ?? 1);
    if (closest === undefined || closest.picture.kind === "empty") {
      return { height: 0, width: 0 };
    } else {
      const divisor = scaleFactor === undefined ? closest.scale : 1;
      return {
        height: Math.round(closest.picture.size.height / divisor),
        width: Math.round(closest.picture.size.width / divisor),
      };
    }
  };

  /** Adds the picture for a scale factor, encoded or as a BGRA bitmap. */
  readonly addRepresentation = (options: {
    scaleFactor?: number;
    width?: number;
    height?: number;
    buffer?: Uint8Array;
    dataURL?: string;
  }) => {
    const { buffer, dataURL, height = 0, scaleFactor = 1, width = 0 } = options;
    const image = (() => {
      if (buffer !== undefined) {
        return width > 0 && height > 0
          ? fromBgra(buffer, { height, width })
          : new NativeImage(pictureOf(buffer));
      } else if (dataURL === undefined) {
        throw new TypeError("addRepresentation takes a buffer or a dataURL");
      } else {
        return nativeImage.createFromDataURL(dataURL);
      }
    })();
    this.#pictures.set(scaleFactor, image.#picture);
  };

  readonly getAspectRatio = () => {
    const { height, width } = this.getSize();
    return height === 0 ? 1 : width / height;
  };

  readonly getScaleFactors = () =>
    [...this.#pictures.keys()].sort((a, b) => a - b);

  readonly toPNG = (options?: { scaleFactor?: number }) => {
    const picture = this.#closest(options?.scaleFactor ?? 1)?.picture ?? EMPTY;
    if (picture.kind === "png") {
      return Buffer.from(picture.bytes);
    } else if (picture.kind === "empty") {
      return Buffer.alloc(0);
    } else {
      return Buffer.from(encodePng(bitmapOf(picture)));
    }
  };

  /** Its JPEG bytes: only an image that came as a JPEG has them. */
  readonly toJPEG = (_quality: number) => {
    if (this.#picture.kind === "jpeg") {
      return Buffer.from(this.#picture.bytes);
    } else if (this.#picture.kind === "empty") {
      return Buffer.alloc(0);
    } else {
      throw new Error(
        "nativeImage can't encode a JPEG on Domicile: only an image read from a JPEG has one",
      );
    }
  };

  readonly toDataURL = (_options?: { scaleFactor?: number }) =>
    `data:image/png;base64,${this.toPNG().toString("base64")}`;

  /** Its pixels as BGRA, row by row, as Electron's bitmaps are. */
  readonly toBitmap = (_options?: { scaleFactor?: number }) =>
    Buffer.from(
      this.#picture.kind === "empty"
        ? new Uint8Array()
        : swapRedBlue(this.#bitmap().rgba),
    );

  readonly getBitmap = (options?: { scaleFactor?: number }) =>
    this.toBitmap(options);

  readonly resize = (options: {
    width?: number;
    height?: number;
    quality?: string;
  }) => {
    if (this.#picture.kind === "empty") {
      return this;
    }
    const { height, width } = this.#picture.size;
    const toWidth =
      options.width ??
      (options.height === undefined
        ? width
        : Math.round((options.height * width) / height));
    const toHeight =
      options.height ??
      (options.width === undefined
        ? height
        : Math.round((options.width * height) / width));
    return fromBitmap(scale(this.#bitmap(), toWidth, toHeight));
  };

  readonly crop = (rect: Rectangle) => {
    if (this.#picture.kind === "empty") {
      return this;
    }
    const bitmap = this.#bitmap();
    const width = Math.max(0, Math.min(rect.width, bitmap.width - rect.x));
    const height = Math.max(0, Math.min(rect.height, bitmap.height - rect.y));
    const rgba = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      const from = ((rect.y + row) * bitmap.width + rect.x) * 4;
      rgba.set(bitmap.rgba.subarray(from, from + width * 4), row * width * 4);
    }
    return fromBitmap({ height, rgba, width });
  };

  /** A macOS look; nothing to do elsewhere. */
  readonly setTemplateImage = (_template: boolean) => undefined;
  readonly isTemplateImage = () => false;

  /** The picture closest to 1. */
  get #picture(): Picture {
    return this.#closest(1)?.picture ?? EMPTY;
  }

  /** The picture whose scale factor is closest to `scaleFactor`. */
  readonly #closest = (scaleFactor: number) =>
    [...this.#pictures.entries()]
      .map(([scale, picture]) => ({ picture, scale }))
      .sort(
        (a, b) =>
          Math.abs(a.scale - scaleFactor) - Math.abs(b.scale - scaleFactor),
      )[0];

  readonly #bitmap = (): Bitmap => bitmapOf(this.#picture);
}

/** `picture`'s pixels: a JPEG's can't be had, as the host can't decode one. */
const bitmapOf = (picture: Picture): Bitmap => {
  if (picture.kind === "jpeg") {
    throw new Error(
      "nativeImage can't decode a JPEG on Domicile, so it can't resize, crop or bitmap one: use a PNG",
    );
  } else if (picture.kind === "empty") {
    return { height: 0, rgba: new Uint8Array(), width: 0 };
  } else {
    return decodePng(picture.bytes);
  }
};

const fromBitmap = (bitmap: Bitmap) =>
  new NativeImage({
    bytes: encodePng(bitmap),
    kind: "png",
    size: { height: bitmap.height, width: bitmap.width },
  });

/** BGRA `buffer` of `size`, as an image. */
const fromBgra = (buffer: Uint8Array, size: Size) => {
  if (buffer.length !== size.width * size.height * 4) {
    throw new Error(
      `a ${size.width}x${size.height} bitmap is ${size.width * size.height * 4} bytes, not ${buffer.length}`,
    );
  }
  return fromBitmap({ ...size, rgba: swapRedBlue(buffer) });
};

/** Electron's `nativeImage` module. */
export const nativeImage = {
  createEmpty: () => new NativeImage(EMPTY),

  createFromBitmap: (
    buffer: Uint8Array,
    options: { width: number; height: number; scaleFactor?: number },
  ) => fromBgra(buffer, options),

  /** A PNG or JPEG, or with `width` and `height`, a BGRA bitmap. */
  createFromBuffer: (
    buffer: Uint8Array,
    options?: { width?: number; height?: number; scaleFactor?: number },
  ) =>
    options?.width !== undefined && options.height !== undefined
      ? fromBgra(buffer, { height: options.height, width: options.width })
      : new NativeImage(pictureOf(buffer)),

  createFromDataURL: (url: string) => {
    const match = /^data:image\/(?:png|jpeg);base64,(.*)$/.exec(url);
    if (match === null) {
      throw new Error(
        "nativeImage reads a base64 PNG or JPEG data: URL on Domicile",
      );
    }
    return new NativeImage(pictureOf(Buffer.from(match[1] ?? "", "base64")));
  },

  /** The file at `path`, or an empty image when there's none, as in Electron. */
  createFromPath: (path: string) => {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return new NativeImage(EMPTY);
      }
      throw error;
    }
    return new NativeImage(pictureOf(bytes));
  },
};
