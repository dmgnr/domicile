import { describe, expect, it } from "bun:test";

import { readingOrder } from "./reading-order";

const at = (
  name: string,
  x: number,
  y: number,
  width = 1920,
  height = 1080,
) => ({
  box: { height, width, x, y },
  name,
});

const namesOf = (screens: readonly { name: string }[]) =>
  screens.map(({ name }) => name);

describe("readingOrder", () => {
  it("reads a row left to right, whatever order the host lists it in", () => {
    expect(
      namesOf(
        readingOrder([
          at("right", 3840, 0),
          at("left", 0, 0),
          at("center", 1920, 0),
        ]),
      ),
    ).toEqual(["left", "center", "right"]);
  });

  it("puts a short screen in the row of the tall ones it sits beside", () => {
    // A laptop bottom-aligned left of two portrait monitors: its top edge is
    // lower than theirs, but it is beside them, not under them.
    const laptop = at("laptop", 0, 1600, 1920, 1280);
    const center = at("center", 1920, 0, 1600, 2880);
    const right = at("right", 3520, 0, 1600, 2880);

    expect(namesOf(readingOrder([center, laptop, right]))).toEqual([
      "laptop",
      "center",
      "right",
    ]);
  });

  it("reads a screen below the others after them", () => {
    const below = at("laptop", 960, 1080);

    expect(
      namesOf(readingOrder([below, at("above", 0, 0, 3840, 1080)])),
    ).toEqual(["above", "laptop"]);
  });
});
