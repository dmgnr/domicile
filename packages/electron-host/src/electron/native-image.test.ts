import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodePng, encodePng } from "../png";
import { nativeImage } from "./native-image";

/** A 2x1 picture: opaque red, then half-clear blue. */
const RED_BLUE = {
  height: 1,
  rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]),
  width: 2,
};
const RED_BLUE_PNG = Buffer.from(encodePng(RED_BLUE));

/** A JPEG's first bytes, with a baseline frame 3 wide and 2 high. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08,
  0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

describe("nativeImage", () => {
  it("makes an empty image", () => {
    const image = nativeImage.createEmpty();

    expect(image.isEmpty()).toBe(true);
    expect(image.getSize()).toEqual({ height: 0, width: 0 });
    expect(image.toPNG().length).toBe(0);
    expect(image.toDataURL()).toBe("data:image/png;base64,");
  });

  it("reads a PNG from a file, a buffer or a data URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-image-"));
    const path = join(directory, "icon.png");
    await writeFile(path, RED_BLUE_PNG);

    for (const image of [
      nativeImage.createFromPath(path),
      nativeImage.createFromBuffer(RED_BLUE_PNG),
      nativeImage.createFromDataURL(
        `data:image/png;base64,${RED_BLUE_PNG.toString("base64")}`,
      ),
    ]) {
      expect(image.isEmpty()).toBe(false);
      expect(image.getSize()).toEqual({ height: 1, width: 2 });
      expect(image.getAspectRatio()).toBe(2);
      expect(Buffer.compare(image.toPNG(), RED_BLUE_PNG)).toBe(0);
    }
  });

  it("is empty for a file that isn't there, as Electron's is", () => {
    expect(nativeImage.createFromPath("/no/such/icon.png").isEmpty()).toBe(
      true,
    );
  });

  it("keeps a JPEG as it is, and says it can't turn it into a PNG", () => {
    const image = nativeImage.createFromBuffer(JPEG);

    expect(image.getSize()).toEqual({ height: 2, width: 3 });
    expect(Buffer.compare(image.toJPEG(90), JPEG)).toBe(0);
    expect(() => image.toPNG()).toThrow("can't decode a JPEG");
  });

  it("gives and takes bitmaps as BGRA, as Electron's are", () => {
    const image = nativeImage.createFromBuffer(RED_BLUE_PNG);
    const bitmap = image.toBitmap();

    expect([...bitmap]).toEqual([0, 0, 255, 255, 255, 0, 0, 128]);
    expect([...image.getBitmap()]).toEqual([...bitmap]);
    expect(
      decodePng(
        nativeImage.createFromBitmap(bitmap, { height: 1, width: 2 }).toPNG(),
      ),
    ).toEqual(RED_BLUE);
    expect(
      nativeImage.createFromBuffer(bitmap, { height: 1, width: 2 }).getSize(),
    ).toEqual({ height: 1, width: 2 });
  });

  it("resizes, keeping its shape when given one side", () => {
    const image = nativeImage.createFromBuffer(RED_BLUE_PNG);

    const wide = image.resize({ width: 4 });
    expect(wide.getSize()).toEqual({ height: 2, width: 4 });
    // Each corner keeps its own color.
    const pixels = decodePng(wide.toPNG()).rgba;
    expect([...pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...pixels.subarray(12, 16)]).toEqual([0, 0, 255, 128]);

    expect(image.resize({ height: 2, width: 1 }).getSize()).toEqual({
      height: 2,
      width: 1,
    });
  });

  it("crops", () => {
    const image = nativeImage.createFromBuffer(RED_BLUE_PNG);

    expect(
      decodePng(image.crop({ height: 1, width: 1, x: 1, y: 0 }).toPNG()),
    ).toEqual({ height: 1, rgba: new Uint8Array([0, 0, 255, 128]), width: 1 });
  });

  it("refuses a buffer it can't tell the kind of", () => {
    expect(() => nativeImage.createFromBuffer(Buffer.from("hello"))).toThrow(
      "neither a PNG nor a JPEG",
    );
  });

  it("keeps a picture per scale factor, giving the closest one", () => {
    const image = nativeImage.createEmpty();
    const twice = encodePng({
      height: 2,
      rgba: new Uint8Array(4 * 4 * 2).fill(255),
      width: 4,
    });

    image.addRepresentation({ buffer: RED_BLUE_PNG, scaleFactor: 1 });
    image.addRepresentation({
      dataURL: `data:image/png;base64,${Buffer.from(twice).toString("base64")}`,
      scaleFactor: 2,
    });

    expect(image.isEmpty()).toBe(false);
    expect(image.getScaleFactors()).toEqual([1, 2]);
    expect(image.getSize()).toEqual({ height: 1, width: 2 });
    expect(image.getSize(2)).toEqual({ height: 2, width: 4 });
    expect(image.toPNG({ scaleFactor: 1.8 })).toEqual(Buffer.from(twice));
    expect(image.toPNG()).toEqual(RED_BLUE_PNG);
  });

  it("takes a representation as a BGRA bitmap, and sizes in DIPs from it", () => {
    const image = nativeImage.createEmpty();

    image.addRepresentation({
      buffer: Buffer.alloc(4 * 2 * 4),
      height: 2,
      scaleFactor: 2,
      width: 4,
    });

    expect(image.getScaleFactors()).toEqual([2]);
    expect(image.getSize()).toEqual({ height: 1, width: 2 });
  });
});
