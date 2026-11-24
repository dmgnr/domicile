import { describe, expect, it } from "bun:test";

import { describedAction, describedChange } from "./window-log";
import { NO_WINDOWS, reduceWindows, WindowAction } from "./window-state";

describe("describedAction", () => {
  it("names the action and the windows it is about", () => {
    expect(
      describedAction(WindowAction.WindowMovedToWorkspace("app:7", "3")),
    ).toBe('WindowMovedToWorkspace id="app:7" name="3"');
  });

  it("leaves out what a window says", () => {
    expect(
      describedAction(WindowAction.AppTitled("7", "My bank statement")),
    ).toBe('AppTitled appId="7"');
  });

  it("leaves out addresses and commands", () => {
    expect(describedAction(WindowAction.AppLaunched(["rm", "-rf", "~"]))).toBe(
      "AppLaunched",
    );
  });

  it("shows a box whole", () => {
    expect(
      describedAction(
        WindowAction.WindowResized("app:7", {
          height: 4,
          width: 3,
          x: 1,
          y: 2,
        }),
      ),
    ).toBe('WindowResized id="app:7" box={"height":4,"width":3,"x":1,"y":2}');
  });
});

describe("describedChange", () => {
  it("says what changed", () => {
    const after = reduceWindows(NO_WINDOWS, WindowAction.OverviewToggled());
    expect(describedChange(NO_WINDOWS, after)).toBe("overview=false->true");
  });

  it("says nothing when nothing it tells changed", () => {
    expect(describedChange(NO_WINDOWS, NO_WINDOWS)).toBeUndefined();
  });
});
