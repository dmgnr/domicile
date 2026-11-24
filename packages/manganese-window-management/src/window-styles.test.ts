import { describe, expect, it } from "bun:test";

import { Layout } from "./tree/node";
import {
  clippedAlong,
  clippedTo,
  collapsedAlong,
  contentsScaledAbout,
  movingStyles,
  placedAt,
  scaledAbout,
  shuffledBy,
  slidAcross,
  slidingAcross,
} from "./window-styles";

const RECT = { height: 200, width: 300, x: 10, y: 20 };

describe("placedAt", () => {
  it("places a window in the desktop's own coordinates", () => {
    // Absolute, not fixed, so the wrapper that clips a switch to its screen
    // holds it. That wrapper, like the page, starts at the desktop's corner.
    expect(placedAt(RECT, 0).position).toBe("absolute");
  });

  it("puts the window where the rectangle says", () => {
    expect(placedAt(RECT, 0)).toMatchObject({
      blockSize: "200px",
      inlineSize: "300px",
      insetBlockStart: "20px",
      insetInlineStart: "10px",
    });
  });

  it("writes the depth as the element's own z-index", () => {
    // The compositor stacks the client's surface by the element's own z-index.
    expect(placedAt(RECT, 3).zIndex).toBe(3);
  });
});

// A window's bar and contents, and the frame they span.
const FRAME = { height: 1048, width: 1920, x: 0, y: 32 };
const BAR = { height: 30, width: 1920, x: 0, y: 32 };
const SURFACE = { height: 1018, width: 1920, x: 0, y: 62 };

describe("scaledAbout", () => {
  // Bar and contents share one origin so they don't pull apart when scaled.
  it("turns the contents about the middle of the whole frame", () => {
    // The frame's center is (960, 556), 494px below the contents' top.
    expect(scaledAbout(FRAME, SURFACE).transformOrigin).toBe("960px 494px");
  });

  it("turns the bar about that same point, which is below the bar", () => {
    expect(scaledAbout(FRAME, BAR).transformOrigin).toBe("960px 524px");
  });

  it("turns a box that is the whole frame about its own middle", () => {
    // A hidden tab's window shows only its tab, so the tab is the frame.
    expect(scaledAbout(BAR, BAR).transformOrigin).toBe("960px 15px");
  });
});

describe("shuffledBy", () => {
  it("hands the shuffle to the keyframes as custom properties", () => {
    expect(
      shuffledBy({ away: { x: -48, y: 12 }, from: 1, id: "a", to: 2 }),
    ).toStrictEqual({
      "--restack-from": 1,
      "--restack-to": 2,
      "--restack-x": "-48px",
      "--restack-y": "12px",
    });
  });

  it("is nothing for a window that is not shuffling", () => {
    expect(shuffledBy(undefined)).toStrictEqual({});
  });
});

describe("collapsedAlong", () => {
  // Across for a tabbed container, down for a stack.
  it("hands the way a tab closes up to the keyframes", () => {
    expect(collapsedAlong(Layout.Tabbed)).toStrictEqual({
      "--collapse-x": 0,
    });
    expect(collapsedAlong(Layout.Stacking)).toStrictEqual({
      "--collapse-y": 0,
    });
  });

  it("is nothing for a bar that is not a tab", () => {
    expect(collapsedAlong(undefined)).toStrictEqual({});
  });
});

describe("movingStyles", () => {
  const classes = (styles: string): readonly string[] => styles.split(" ");

  /** What a closing tab's contents have that its bar lacks: the delay. */
  const delayed = (): readonly string[] => {
    const bar = classes(movingStyles({ motion: "closing-tab" }));
    return classes(
      movingStyles({ contents: true, motion: "closing-tab" }),
    ).filter((name) => !bar.includes(name));
  };

  // The tab a close uncovers takes a frame or two to show; see `contents`.
  it("starts a closing tab's contents fading after its bar collapses", () => {
    expect(delayed()).not.toHaveLength(0);
  });

  // A fade alone, over the tab it hides, reads as a tab switch.
  it("grows a new tab's contents in, not only its bar", () => {
    expect(movingStyles({ contents: true, motion: "opening-tab" })).not.toBe(
      movingStyles({ motion: "opening-tab" }),
    );
  });

  // Both scale about one point, so they must keep time to stay together.
  it("starts a sent tab's bar as late as its contents", () => {
    expect(movingStyles({ contents: true, motion: "sending-tab" })).toBe(
      movingStyles({ motion: "sending-tab" }),
    );
  });

  /** What the uncovered tab's contents have that its bar lacks. */
  const uncoveringDelay = (): readonly string[] => {
    const bar = classes(movingStyles({ motion: "uncovering" }));
    return classes(
      movingStyles({ contents: true, motion: "uncovering" }),
    ).filter((name) => !bar.includes(name));
  };

  it("holds the uncovered tab under the closing one for as long", () => {
    expect(uncoveringDelay()).not.toHaveLength(0);
    expect(delayed()).toEqual(expect.arrayContaining([...uncoveringDelay()]));
  });

  // A fade alone, over the tab it uncovers, reads as a tab switch.
  it("shrinks a closing tab's contents rather than only fading them", () => {
    expect(
      delayed().filter((name) => !uncoveringDelay().includes(name)),
    ).not.toHaveLength(0);
  });

  it("starts other motions at once", () => {
    expect(movingStyles({ contents: true, motion: "closing" })).toBe(
      movingStyles({ motion: "closing" }),
    );
  });
});

describe("slidAcross", () => {
  const SCREEN = { height: 1080, width: 1920, x: 0, y: 0 };

  // A scratchpad slide that cuts the other short starts partway in.
  const FLOAT = { height: 400, width: 600, x: 40, y: 200 };

  it("starts the slide as far in as the window was rewound", () => {
    expect(slidAcross(SCREEN, undefined, "dropping", 300)).toMatchObject({
      "--motion-delay": "-300ms",
    });
  });

  it.each(["dropping", "stowing"] as const)(
    "lifts a %s window clear of the screen's top edge",
    (motion) => {
      expect(slidAcross(SCREEN, FLOAT, motion, 0)).toMatchObject({
        "--lift": "600px",
      });
    },
  );

  // A dragged float changes its frame every frame. A lift that followed it
  // would restyle and repaint every part of the window each time.
  it("leaves out the lift while the scratchpad is not sliding the window", () => {
    expect(slidAcross(SCREEN, FLOAT, "resting", 0)).not.toHaveProperty(
      "--lift",
    );
  });
});

describe("clippedTo", () => {
  const SCREEN = { height: 1024, width: 1280, x: 1920, y: 0 };

  // The page spans every monitor; a slide would show on the next one.
  it.each([
    "arriving-from-end",
    "arriving-from-start",
    "leaving-to-end",
    "leaving-to-start",
  ] as const)("clips a %s window to its screen", (motion) => {
    expect(clippedTo(SCREEN, motion)).toStrictEqual({
      clip: "rect(0px, 3200px, 1024px, 1920px)",
    });
  });

  // A float dragged across screens draws on both.
  it("leaves any other window unclipped", () => {
    expect(clippedTo(SCREEN, "resting")).toStrictEqual({});
  });
});

describe("slidingAcross", () => {
  const SCREEN = { height: 1024, width: 1280, x: 1920, y: 0 };

  it.each([
    "arriving-from-end",
    "arriving-from-start",
    "leaving-to-end",
    "leaving-to-start",
  ] as const)("names the screen a %s window slides across", (motion) => {
    expect(slidingAcross(SCREEN, motion)).toBe(SCREEN);
  });

  it("names none for a window no switch slides", () => {
    expect(slidingAcross(SCREEN, "dropping")).toBeUndefined();
  });
});

describe("clippedAlong", () => {
  const SCREEN = { height: 1024, width: 1280, x: 1920, y: 0 };

  // In the part's own box, so the clip slides with it and a float hanging
  // off the screen's edge stays off its workspace.
  it("clips a sliding part to its screen, from the part's own corner", () => {
    expect(
      clippedAlong(SCREEN, { height: 400, width: 600, x: 2800, y: 100 }),
    ).toStrictEqual({ clip: "rect(-100px, 400px, 924px, -880px)" });
  });

  it("leaves a part no switch slides unclipped", () => {
    expect(clippedAlong(undefined, RECT)).toStrictEqual({});
  });
});

describe("contentsScaledAbout", () => {
  const frame = { height: 432, width: 600, x: 0, y: 0 };
  const tab = { height: 32, width: 100, x: 100, y: 0 };
  const contents = { height: 400, width: 600, x: 0, y: 32 };

  it("scales a window's contents about its whole frame", () => {
    expect(contentsScaledAbout("closing", frame, tab, contents)).toStrictEqual(
      scaledAbout(frame, contents),
    );
  });

  // So they are seen to go into it.
  it("shrinks a closing tab's contents about its tab", () => {
    expect(
      contentsScaledAbout("closing-tab", frame, tab, contents),
    ).toStrictEqual(scaledAbout(tab, contents));
  });

  it("grows a new tab's contents out of its tab", () => {
    expect(
      contentsScaledAbout("opening-tab", frame, tab, contents),
    ).toStrictEqual(scaledAbout(tab, contents));
  });

  it("falls back to the frame when the tab is unknown", () => {
    expect(
      contentsScaledAbout("opening-tab", frame, undefined, contents),
    ).toStrictEqual(scaledAbout(frame, contents));
  });
});
