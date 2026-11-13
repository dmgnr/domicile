import { describe, expect, it } from "bun:test";
import { Direction } from "../direction";
import { movedBox, openingBox, resizedBox } from "./pip-box";

// A 1920x1080 screen whose workspace starts under a 40px bar.
const WORKSPACE = { height: 1040, width: 1920, x: 0, y: 40 };
const VIDEO = { height: 360, width: 640 };

describe("openingBox", () => {
  it("opens small, in the workspace's bottom-right corner, in the video's shape", () => {
    expect(openingBox(WORKSPACE, VIDEO)).toEqual({
      height: 270,
      width: 480,
      x: 1920 - 24 - 480,
      y: 40 + 1040 - 24 - 270,
    });
  });

  it("is square for a video with no size yet", () => {
    const box = openingBox(WORKSPACE, { height: 0, width: 0 });

    expect(box.width).toBe(box.height);
  });

  it("is never wider than a small screen", () => {
    const narrow = { height: 600, width: 260, x: 1920, y: 0 };

    expect(openingBox(narrow, VIDEO)).toEqual({
      height: 119,
      width: 212,
      x: 1920 + 24,
      y: 600 - 24 - 119,
    });
  });
});

describe("movedBox", () => {
  const box = { height: 270, width: 480, x: 1000, y: 500 };

  it("follows the pointer", () => {
    expect(movedBox(box, WORKSPACE, -100, -50)).toEqual({
      ...box,
      x: 900,
      y: 450,
    });
  });

  it("stays on its screen", () => {
    expect(movedBox(box, WORKSPACE, 5000, -5000)).toEqual({
      ...box,
      x: 1920 - 480,
      y: 40,
    });
  });
});

describe("resizedBox", () => {
  const box = { height: 270, width: 480, x: 1000, y: 500 };
  const shape = VIDEO;

  it("keeps the video's shape from a side edge", () => {
    expect(
      resizedBox(
        box,
        WORKSPACE,
        shape,
        { horizontal: Direction.Right, vertical: undefined },
        160,
        0,
      ),
    ).toEqual({ height: 360, width: 640, x: 1000, y: 500 });
  });

  it("grows from the top-left corner toward it, keeping the opposite corner", () => {
    expect(
      resizedBox(
        box,
        WORKSPACE,
        shape,
        { horizontal: Direction.Left, vertical: Direction.Up },
        -160,
        0,
      ),
    ).toEqual({ height: 360, width: 640, x: 840, y: 410 });
  });

  it("follows the bottom edge in the video's shape", () => {
    expect(
      resizedBox(
        box,
        WORKSPACE,
        shape,
        { horizontal: undefined, vertical: Direction.Down },
        0,
        -90,
      ),
    ).toEqual({ height: 180, width: 320, x: 1000, y: 500 });
  });

  it("is never smaller than a usable video", () => {
    expect(
      resizedBox(
        box,
        WORKSPACE,
        shape,
        { horizontal: Direction.Right, vertical: undefined },
        -1000,
        0,
      ).width,
    ).toBe(240);
  });

  it("never grows past its screen", () => {
    const grown = resizedBox(
      box,
      WORKSPACE,
      shape,
      { horizontal: Direction.Right, vertical: undefined },
      5000,
      0,
    );

    expect(grown.x + grown.width).toBeLessThanOrEqual(1920);
    expect(grown.y + grown.height).toBeLessThanOrEqual(1080);
  });
});
