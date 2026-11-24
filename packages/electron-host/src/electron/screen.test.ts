import { describe, expect, it } from "bun:test";

import type { ListedDisplay } from "./screen";
import { createScreen } from "./screen";

const LAPTOP: ListedDisplay = {
  lit: true,
  mode: [2256, 1504],
  name: "drm-1",
  names: ["drm-1", "eDP-1", "BOE NE135A1M-NY1"],
  position: [0, 0],
  refresh_mhz: 59_999,
  size: [1504, 1003],
  transform: "normal",
};
const PORTRAIT: ListedDisplay = {
  lit: true,
  mode: [3840, 2160],
  name: "drm-2",
  names: ["drm-2", "DP-1", "Dell U2723QE"],
  position: [1504, 0],
  size: [1800, 3200],
  transform: "rotate-90",
};

describe("screen", () => {
  it("gives the desktop's lit displays as Electron's", () => {
    const screen = createScreen(
      () => [LAPTOP, PORTRAIT, { ...PORTRAIT, lit: false, name: "drm-3" }],
      () => undefined,
    );

    const [laptop, portrait] = screen.getAllDisplays();
    if (laptop === undefined || portrait === undefined) {
      throw new Error("expected two displays");
    }

    expect(screen.getAllDisplays()).toHaveLength(2);
    expect(laptop).toMatchObject({
      bounds: { height: 1003, width: 1504, x: 0, y: 0 },
      displayFrequency: 59.999,
      internal: true,
      label: "BOE NE135A1M-NY1",
      scaleFactor: 1.5,
    });
    expect(portrait).toMatchObject({
      internal: false,
      rotation: 90,
      scaleFactor: 1.2,
    });
    expect(screen.getPrimaryDisplay()).toEqual(laptop);
    expect(screen.getDisplayNearestPoint({ x: 3000, y: 50 })).toEqual(portrait);
    expect(
      screen.getDisplayMatching({ height: 100, width: 400, x: 1400, y: 10 }),
    ).toEqual(portrait);
  });

  it("says when a display comes, changes and goes", () => {
    let changed: (displays: readonly ListedDisplay[]) => void = () => undefined;
    const screen = createScreen(
      () => [LAPTOP],
      (hear) => {
        changed = hear;
      },
    );
    const seen: string[] = [];
    screen.getAllDisplays();
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ]) {
      screen.on(event, (_event, display, metrics) => {
        seen.push(`${event} ${display.label}${metrics ? ` ${metrics}` : ""}`);
      });
    }

    changed([LAPTOP, PORTRAIT]);
    changed([{ ...LAPTOP, size: [1128, 752] }, PORTRAIT]);
    changed([PORTRAIT]);

    expect(seen).toEqual([
      "display-added Dell U2723QE",
      "display-metrics-changed BOE NE135A1M-NY1 bounds,scaleFactor",
      "display-removed BOE NE135A1M-NY1",
    ]);
  });
});
