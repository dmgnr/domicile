import { describe, expect, it } from "bun:test";

import { seenAt, seenClip, seenStyles } from "./seen-styles";

const SCREEN = { height: 1080, width: 1920, x: 1920, y: 0 };
const SEEN = {
  arriving: undefined,
  fading: false,
  shut: false,
  view: { scale: 0.25, x: 100, y: 50 },
};

describe("seenAt", () => {
  it("leaves a window alone outside the overview", () => {
    expect(seenAt(undefined, SCREEN)).toStrictEqual({});
  });

  it("shrinks it into its tile", () => {
    expect(seenAt(SEEN, SCREEN)["--overview-to"]).toBe(
      "matrix(0.25, 0, 0, 0.25, 100, 50)",
    );
    expect(seenStyles.raw({}).transform).toBe("var(--overview-to, none)");
  });

  it("keeps its move from its window's parts, so setting it restyles the box alone", () => {
    expect(seenStyles.raw({})["& > *"]).toStrictEqual({
      "--overview-from": "initial",
      "--overview-to": "initial",
    });
  });

  it("clips it to its screen as it moves, so a float hanging off the edge stays in its tile", () => {
    expect(seenAt(SEEN, SCREEN).clip).toBe("rect(0px, 3840px, 1080px, 1920px)");
  });

  it("fades it while the overview closes", () => {
    expect(seenAt(SEEN, SCREEN).opacity).toBe(1);
    expect(seenAt({ ...SEEN, fading: true }, SCREEN).opacity).toBe(0);
  });

  it("starts a window coming into view from where it sat beside the shown workspace", () => {
    expect(
      seenAt({ ...SEEN, arriving: { scale: 1, x: 3000, y: 0 } }, SCREEN)[
        "--overview-from"
      ],
    ).toBe("matrix(1, 0, 0, 1, 3000, 0)");
    expect(seenStyles.raw({ arriving: true })).toMatchObject({
      _starting: { transform: "var(--overview-from)" },
    });
  });

  it("eases between its states, so closing partway through opening turns back", () => {
    expect(seenStyles.raw({ seen: true }).transition).toContain("transform");
    expect(seenStyles.raw({ arriving: true })).not.toHaveProperty("animation");
  });

  it("drops its move at once as the overview finishes closing, so its window keeps its place in the stack", () => {
    // A box still easing to no transform is a stacking context of its own,
    // and with the wrapper's depth gone, a float under it sinks below the
    // tiled windows until the ease ends.
    expect(seenStyles.raw({ seen: false })).not.toHaveProperty("transition");
  });

  it("is out of view while its window is, so it comes into view with it", () => {
    expect(seenStyles.raw({ placed: false }).display).toBe("none");
    expect(seenStyles.raw({ placed: true })).not.toHaveProperty("display");
  });

  it("lets presses through a hidden workspace's window, even its tab strip's buttons", () => {
    // Once the overview's picker is gone, a press on a hidden workspace's
    // window as it fades must not go to that workspace. The strips set their
    // own `pointer-events`, so the rule reaches every part, not only the
    // wrapper.
    expect(seenStyles.raw({ shut: false })).not.toHaveProperty("& *");
    expect(seenStyles.raw({ shut: true })).toMatchObject({
      "& *": { pointerEvents: "none!" },
      pointerEvents: "none",
    });
  });
});

describe("seenClip", () => {
  it("leaves a window alone outside the overview", () => {
    expect(seenClip(undefined, SCREEN, 3)).toStrictEqual({});
  });

  it("clips it to its screen, so it shows only on its own monitor, stacked at its own depth", () => {
    expect(seenClip(SEEN, SCREEN, 3)).toStrictEqual({
      clip: "rect(0px, 3840px, 1080px, 1920px)",
      zIndex: 3,
    });
  });
});
