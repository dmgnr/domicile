// Reads and writes PNGs, for `nativeImage`: what a resize, a crop or a bitmap
// needs, with no image library. Interlaced files and gray below 8 bits are
// refused, loudly, until an app needs them.

import { deflateSync, inflateSync } from "node:zlib";

/** A picture, row by row from the top, 4 bytes a pixel: R, G, B, A. */
export type Bitmap = {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
};

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const isPng = (bytes: Uint8Array) =>
  bytes.length >= 24 && SIGNATURE.every((byte, at) => bytes[at] === byte);

/** A PNG's size, from its header, or undefined for something else. */
export const pngSize = (bytes: Uint8Array) => {
  if (!isPng(bytes)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
};

/** Each chunk's type and data, in order. */
const chunks = function* (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    yield { data: bytes.subarray(at + 8, at + 8 + length), type };
    at += 12 + length;
  }
};

/** Channels a pixel has, by color type. */
const CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};
const KINDS: Readonly<Record<number, string>> = {
  0: "gray",
  2: "RGB",
  3: "palette",
  4: "gray and alpha",
  6: "RGBA",
};

const paeth = (left: number, up: number, upLeft: number) => {
  const guess = left + up - upLeft;
  const toLeft = Math.abs(guess - left);
  const toUp = Math.abs(guess - up);
  const toUpLeft = Math.abs(guess - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  } else if (toUp <= toUpLeft) {
    return up;
  } else {
    return upLeft;
  }
};

/** Undoes each row's filter in place, answering the rows without them. */
const unfilter = (
  data: Uint8Array,
  height: number,
  stride: number,
  step: number,
) => {
  const out = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = data[row * (stride + 1)];
    const line = data.subarray(
      row * (stride + 1) + 1,
      (row + 1) * (stride + 1),
    );
    const at = row * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= step ? (out[at + x - step] ?? 0) : 0;
      const up = row > 0 ? (out[at - stride + x] ?? 0) : 0;
      const upLeft =
        row > 0 && x >= step ? (out[at - stride + x - step] ?? 0) : 0;
      const raw = line[x] ?? 0;
      const predicted = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upLeft),
      ][filter ?? 0];
      if (predicted === undefined) {
        throw new Error(
          `this PNG has a row filter ${filter}, which PNG has not`,
        );
      }
      out[at + x] = (raw + predicted) & 0xff;
    }
  }
  return out;
};

/** Reads a PNG into RGBA. */
export const decodePng = (bytes: Uint8Array): Bitmap => {
  if (!isPng(bytes)) {
    throw new Error("not a PNG: its first bytes are not PNG's signature");
  }
  let header: Uint8Array | undefined;
  let palette: Uint8Array = new Uint8Array();
  let transparency: Uint8Array = new Uint8Array();
  const data: Uint8Array[] = [];
  for (const chunk of chunks(bytes)) {
    if (chunk.type === "IHDR") {
      header = chunk.data;
    } else if (chunk.type === "PLTE") {
      palette = chunk.data;
    } else if (chunk.type === "tRNS") {
      transparency = chunk.data;
    } else if (chunk.type === "IDAT") {
      data.push(chunk.data);
    }
  }
  if (header === undefined) {
    throw new Error("not a PNG: it has no IHDR");
  }
  const view = new DataView(header.buffer, header.byteOffset, 13);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = header[8] ?? 0;
  const colorType = header[9] ?? 0;
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`this PNG has color type ${colorType}, which PNG has not`);
  } else if (header[12] !== 0) {
    throw new Error("interlaced PNGs aren't read yet");
  } else if (depth !== 8 && !(depth === 16 && colorType !== 3)) {
    throw new Error(
      `${depth}-bit ${KINDS[colorType]} PNGs aren't read yet: only 8 bits, or 16 outside a palette`,
    );
  }
  const bytesPerSample = depth / 8;
  const step = channels * bytesPerSample;
  const rows = unfilter(
    inflateSync(Buffer.concat(data)),
    height,
    width * step,
    step,
  );
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    // The high byte of each sample.
    const sample = (channel: number) =>
      rows[pixel * step + channel * bytesPerSample] ?? 0;
    const out = pixel * 4;
    if (colorType === 3) {
      const index = sample(0);
      rgba.set(palette.subarray(index * 3, index * 3 + 3), out);
      rgba[out + 3] = transparency[index] ?? 255;
    } else if (colorType === 0 || colorType === 4) {
      rgba.fill(sample(0), out, out + 3);
      rgba[out + 3] = colorType === 4 ? sample(1) : 255;
    } else {
      rgba[out] = sample(0);
      rgba[out + 1] = sample(1);
      rgba[out + 2] = sample(2);
      rgba[out + 3] = colorType === 6 ? sample(3) : 255;
    }
  }
  return { height, rgba, width };
};

const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(
    8 + data.length,
    Bun.hash.crc32(out.subarray(4, 8 + data.length)),
  );
  return out;
};

/** Writes RGBA as a PNG. */
export const encodePng = ({ height, rgba, width }: Bitmap): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    rows.set(
      rgba.subarray(row * width * 4, (row + 1) * width * 4),
      row * (width * 4 + 1) + 1,
    );
  }
  return new Uint8Array(
    Buffer.concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
};
