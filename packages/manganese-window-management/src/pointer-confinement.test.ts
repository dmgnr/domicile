import { describe, expect, it } from "bun:test";
import { listedWindow } from "@domicile-desktop/sdk/fake-host";

import { confinementAsk, confinementBoxes } from "./pointer-confinement";

const game = (fields: Parameters<typeof listedWindow>[1] = {}) =>
  listedWindow("game", {
    height: 300,
    pointerConstraint: "confine",
    width: 400,
    ...fields,
  });

const at = { height: 600, width: 800, x: 100, y: 50 };

describe("confinementAsk", () => {
  it("is the focused window's ask to confine", () => {
    expect(confinementAsk([game()], "game", "game")).toBeDefined();
  });

  it("is nothing for a window without the keyboard, or one asking to lock", () => {
    expect(confinementAsk([game()], "term", "game")).toBeUndefined();
    expect(
      confinementAsk([game({ pointerConstraint: "lock" })], "game", "game"),
    ).toBeUndefined();
    expect(confinementAsk([], "game", "game")).toBeUndefined();
  });

  it("is the same string for the same ask, so nothing re-renders", () => {
    expect(confinementAsk([game()], "game", "game")).toBe(
      confinementAsk([game()], "game", "game") ?? "",
    );
  });
});

describe("confinementBoxes", () => {
  it("is the whole window for no region", () => {
    const ask = confinementAsk([game()], "game", "game") ?? "";
    expect(confinementBoxes(at, ask)).toEqual([at]);
  });

  it("scales a region from the client's size to the window's", () => {
    // Drawn at twice the client's size.
    const ask =
      confinementAsk(
        [game({ pointerRegion: [new DOMRectReadOnly(10, 20, 100, 50)] })],
        "game",
        "game",
      ) ?? "";
    expect(confinementBoxes(at, ask)).toEqual([
      { height: 100, width: 200, x: 120, y: 90 },
    ]);
  });

  it("clips a region to the window and leaves out what is off it", () => {
    const ask =
      confinementAsk(
        [
          game({
            pointerRegion: [
              new DOMRectReadOnly(350, 250, 100, 100),
              new DOMRectReadOnly(500, 0, 10, 10),
            ],
          }),
        ],
        "game",
        "game",
      ) ?? "";
    expect(confinementBoxes(at, ask)).toEqual([
      { height: 100, width: 100, x: 800, y: 550 },
    ]);
  });

  it("is nothing for a window drawn at no size", () => {
    const ask = confinementAsk([game()], "game", "game") ?? "";
    expect(confinementBoxes({ ...at, width: 0 }, ask)).toEqual([]);
  });
});
