import { describe, expect, it } from "bun:test";

import { floatFor, scratchpadFloatFor } from "../floating/float";
import { LayoutNode } from "../tree/node";
import { popupSceneOf } from "./popup-scene";
import type { StageScreen } from "./stage-screens";

const RECT = { height: 1080, width: 1920, x: 0, y: 0 };

/** Nothing open over the windows. */
const DESK = { clipboardOpen: false, launcherOpen: false, overviewOpen: false };

/** A screen showing workspace 1 with no fullscreen or floating window. */
const SCREEN: StageScreen = {
  current: "1",
  floats: [],
  fullscreen: undefined,
  geometry: { desktop: RECT, name: "DP-1", screen: RECT, workspace: RECT },
  screenful: { focusBox: undefined, placements: [], tabs: [] },
};

describe("popupSceneOf", () => {
  it.each([
    ["the overview opens", { ...DESK, overviewOpen: true }, SCREEN],
    ["the launcher opens", { ...DESK, launcherOpen: true }, SCREEN],
    ["the clipboard opens", { ...DESK, clipboardOpen: true }, SCREEN],
    ["a screen switches workspace", DESK, { ...SCREEN, current: "2" }],
    [
      "a window goes fullscreen",
      DESK,
      { ...SCREEN, fullscreen: { group: false, windows: ["app:term"] } },
    ],
    [
      "a scratchpad window shows",
      DESK,
      {
        ...SCREEN,
        floats: [scratchpadFloatFor(LayoutNode.Window("app:notes"), RECT)],
      },
    ],
  ])("changes when %s", (_, desk, screen) => {
    expect(popupSceneOf(desk, [screen])).not.toBe(popupSceneOf(DESK, [SCREEN]));
  });

  it("stays when a window floats, which moves only that window", () => {
    expect(
      popupSceneOf(DESK, [
        {
          ...SCREEN,
          floats: [floatFor(LayoutNode.Window("app:term"), 0, RECT)],
        },
      ]),
    ).toBe(popupSceneOf(DESK, [SCREEN]));
  });
});
