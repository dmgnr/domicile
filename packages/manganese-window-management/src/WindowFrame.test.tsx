import { afterEach, describe, expect, it } from "bun:test";
import { Button } from "@domicile-desktop/component-library/Button";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { APP_KEY_DELIVERED_EVENT } from "@domicile-desktop/sdk/app-element";
import { WEBVIEW_KEY_DELIVERED_EVENT } from "@domicile-desktop/sdk/webview-element";
import {
  drawAt,
  drawPopups,
  popupLeft,
  undrawPopups,
} from "@domicile-desktop/test-support/popup-layout";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext } from "react";
import type { Seen } from "./overview/sight";
import { SlidingScreen } from "./sliding-screen";
import { WindowFrame } from "./WindowFrame";
import type { WindowMotion } from "./window-motion";
import { clippedAlong } from "./window-styles";

/** A part at the desktop's corner that clips itself as a switch slides it. */
const SlidingPart = () => (
  <button
    style={clippedAlong(useContext(SlidingScreen), {
      height: 100,
      width: 100,
      x: 0,
      y: 0,
    })}
    type="button"
  >
    sliding part
  </button>
);

const noHover = () => {
  // Nothing in the case moves the pointer into the window.
};

const noReach = () => {
  // Nothing in the case presses the window.
};

describe("WindowFrame", () => {
  afterEach(undrawPopups);

  it("keeps popups opened in the window inside its frame", async () => {
    render(
      <WindowFrame
        depth={0}
        fillsScreen={false}
        frame={{ height: 800, width: 400, x: 0, y: 0 }}
        motion="resting"
        onHover={noHover}
        onReach={noReach}
        rewound={0}
        screen={undefined}
        seen={undefined}
      >
        <Popover trigger={<Button>Site settings</Button>}>Body</Popover>
      </WindowFrame>,
    );
    const trigger = screen.getByRole("button", { name: "Site settings" });
    drawAt(trigger, { height: 28, width: 28, x: 360, y: 40 });
    drawPopups("dialog", { height: 100, width: 300 });

    await userEvent.click(trigger);

    await waitFor(() => {
      expect(popupLeft("dialog") + 300).toBeLessThanOrEqual(400);
    });
  });

  it("reports where the pointer crossed into any part of the window", () => {
    // `usePointerWarp` needs the position to tell a pointer move from a
    // window appearing under the pointer.
    const crossed: (readonly [number, number])[] = [];
    render(
      <WindowFrame
        depth={0}
        fillsScreen={false}
        frame={undefined}
        motion="resting"
        onHover={(at) => {
          crossed.push(at);
        }}
        onReach={noReach}
        rewound={0}
        screen={undefined}
        seen={undefined}
      >
        <button type="button">part</button>
      </WindowFrame>,
    );

    fireEvent.pointerOver(screen.getByRole("button"), {
      clientX: 640,
      clientY: 400,
    });

    expect(crossed).toStrictEqual([[640, 400]]);
  });

  it("reports a press on any part of the window", () => {
    // Even in the active window: focus follows the cursor, but only a press
    // raises a window.
    const reached: string[] = [];
    render(
      <WindowFrame
        depth={0}
        fillsScreen={false}
        frame={undefined}
        motion="resting"
        onHover={noHover}
        onReach={() => {
          reached.push("reach");
        }}
        rewound={0}
        screen={undefined}
        seen={undefined}
      >
        <button type="button">part</button>
      </WindowFrame>,
    );

    fireEvent.pointerDown(screen.getByRole("button"));

    expect(reached).toStrictEqual(["reach"]);
  });

  describe("on a screen", () => {
    const SCREEN = { height: 800, width: 1280, x: 0, y: 100 };
    const styleOf = (
      motion: WindowMotion = "resting",
      seen: Seen | undefined = undefined,
      fillsScreen = false,
    ) => {
      render(
        <WindowFrame
          depth={2}
          fillsScreen={fillsScreen}
          frame={{ height: 400, width: 600, x: 40, y: 300 }}
          motion={motion}
          onHover={noHover}
          onReach={noReach}
          rewound={0}
          screen={SCREEN}
          seen={seen}
        >
          <button type="button">part</button>
        </WindowFrame>,
      );
      const moved = screen.getByRole("button").parentElement;
      return { moved: moved?.style, wrapper: moved?.parentElement?.style };
    };

    // A tab's contents carry an edge while they grow or shrink (see
    // `movingStyles`), whose shadow would spill onto the next display.
    it("takes the edge off a moving tab that fills its screen", () => {
      expect(
        styleOf("resting", undefined, true).wrapper?.getPropertyValue(
          "--tab-edge",
        ),
      ).toBe("none");
    });

    it("slides its parts the width of the screen", () => {
      // A workspace switch slides by the width of the window's screen.
      expect(styleOf().wrapper?.getPropertyValue("--workspace-width")).toBe(
        "1280px",
      );
    });

    it("lifts its parts far enough to clear the top of the screen while the scratchpad slides it", () => {
      // The scratchpad slides a window up off the screen and back down.
      expect(styleOf("dropping").wrapper?.getPropertyValue("--lift")).toBe(
        "600px",
      );
    });

    it("shows its parts through their overview tile, at their depth", () => {
      const { moved, wrapper } = styleOf("resting", {
        arriving: undefined,
        fading: false,
        shut: false,
        view: { scale: 0.5, x: 10, y: 20 },
      });

      expect(moved?.getPropertyValue("--overview-to")).toBe(
        "matrix(0.5, 0, 0, 0.5, 10, 20)",
      );
      expect(wrapper?.zIndex).toBe("2");
    });

    it("clips its parts to their screen both outside and inside what moves them, so they stay on their own monitor and in their tile", () => {
      const { moved, wrapper } = styleOf("resting", {
        arriving: { scale: 1, x: 1280, y: 0 },
        fading: false,
        shut: false,
        view: { scale: 0.5, x: 10, y: 20 },
      });

      expect(wrapper?.clip).toBe("rect(100px, 1280px, 900px, 0px)");
      expect(moved?.clip).toBe("rect(100px, 1280px, 900px, 0px)");
    });
  });

  describe("its parts' own clip", () => {
    const clipOf = (motion: WindowMotion) => {
      render(
        <WindowFrame
          depth={0}
          fillsScreen={false}
          frame={{ height: 400, width: 600, x: 40, y: 300 }}
          motion={motion}
          onHover={noHover}
          onReach={noReach}
          rewound={0}
          screen={{ height: 800, width: 1280, x: 0, y: 100 }}
          seen={undefined}
        >
          <SlidingPart />
        </WindowFrame>,
      );
      return screen.getByRole("button", { name: "sliding part" }).style.clip;
    };

    // A float hanging off the screen would slide into view beside its
    // workspace.
    it("clips each part to its workspace while a switch slides it", () => {
      expect(clipOf("leaving-to-start")).toBe(
        "rect(100px, 1280px, 900px, 0px)",
      );
    });

    it("leaves each part unclipped at rest", () => {
      expect(clipOf("resting")).toBe("");
    });
  });

  it("reports a key reaching either kind of window as a reach", () => {
    // Typing in a window ends a selection around it, as a click does.
    let reaches = 0;
    render(
      <WindowFrame
        depth={0}
        fillsScreen={false}
        frame={undefined}
        motion="resting"
        onHover={noHover}
        onReach={() => {
          reaches += 1;
        }}
        rewound={0}
        screen={undefined}
        seen={undefined}
      >
        <button type="button">part</button>
      </WindowFrame>,
    );

    for (const type of [APP_KEY_DELIVERED_EVENT, WEBVIEW_KEY_DELIVERED_EVENT]) {
      screen
        .getByRole("button")
        .dispatchEvent(new Event(type, { bubbles: true }));
    }

    expect(reaches).toBe(2);
  });
});
