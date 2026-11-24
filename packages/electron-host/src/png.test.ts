import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";

import { decodePng, encodePng, pngSize } from "./png";

/** A 2x2 picture: red, green / blue, half-clear white. */
const PICTURE = {
  height: 2,
  rgba: new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128,
  ]),
  width: 2,
};

/** A PNG file made by hand, from `header` fields and filtered `rows`. */
const png = (
  {
    colorType,
    depth = 8,
    interlace = 0,
    width,
    height,
  }: {
    colorType: number;
    depth?: number;
    interlace?: number;
    width: number;
    height: number;
  },
  rows: readonly number[][],
  extra: readonly [string, number[]][] = [],
) => {
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
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([depth, colorType, 0, 0, interlace], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...extra.map(([type, data]) => chunk(type, new Uint8Array(data))),
    chunk("IDAT", deflateSync(new Uint8Array(rows.flat()))),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(Buffer.concat(parts));
};

describe(encodePng, () => {
  it("writes a PNG that reads back as it was", () => {
    const bytes = encodePng(PICTURE);

    expect(pngSize(bytes)).toEqual({ height: 2, width: 2 });
    expect(decodePng(bytes)).toEqual(PICTURE);
  });
});

describe(decodePng, () => {
  it("undoes each row filter", () => {
    // RGB, one row per filter: none, sub, up, average, Paeth.
    const bytes = png({ colorType: 2, height: 5, width: 2 }, [
      [0, 10, 20, 30, 40, 50, 60],
      [1, 10, 20, 30, 30, 30, 30],
      [2, 1, 1, 1, 1, 1, 1],
      [3, 10, 20, 30, 35, 35, 35],
      [4, 1, 2, 3, 4, 5, 6],
    ]);

    expect([...decodePng(bytes).rgba]).toEqual([
      ...[10, 20, 30, 255, 40, 50, 60, 255],
      ...[10, 20, 30, 255, 40, 50, 60, 255],
      ...[11, 21, 31, 255, 41, 51, 61, 255],
      ...[15, 30, 45, 255, 63, 75, 88, 255],
      ...[16, 32, 48, 255, 67, 80, 94, 255],
    ]);
  });

  it("reads gray, gray with alpha, and a palette with its transparency", () => {
    expect([
      ...decodePng(png({ colorType: 0, height: 1, width: 1 }, [[0, 7]])).rgba,
    ]).toEqual([7, 7, 7, 255]);
    expect([
      ...decodePng(png({ colorType: 4, height: 1, width: 1 }, [[0, 7, 9]]))
        .rgba,
    ]).toEqual([7, 7, 7, 9]);
    expect([
      ...decodePng(
        png(
          { colorType: 3, height: 1, width: 2 },
          [[0, 1, 0]],
          [
            ["PLTE", [1, 2, 3, 4, 5, 6]],
            ["tRNS", [100]],
          ],
        ),
      ).rgba,
    ]).toEqual([4, 5, 6, 255, 1, 2, 3, 100]);
  });

  it("reads a 16-bit picture by its high bytes", () => {
    const bytes = png({ colorType: 6, depth: 16, height: 1, width: 1 }, [
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    ]);

    expect([...decodePng(bytes).rgba]).toEqual([1, 3, 5, 7]);
  });

  it("refuses what it can't read, saying what", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("not a PNG");
    expect(() =>
      decodePng(
        png({ colorType: 2, height: 1, interlace: 1, width: 1 }, [
          [0, 1, 2, 3],
        ]),
      ),
    ).toThrow("interlaced PNGs aren't read yet");
    expect(() =>
      decodePng(png({ colorType: 0, depth: 4, height: 1, width: 1 }, [[0, 0]])),
    ).toThrow("4-bit gray PNGs aren't read yet");
  });
});
