import { beforeEach, describe, expect, it } from "bun:test";
import {
  APP_FOCUS_REQUESTED_EVENT,
  APP_TAG_NAME,
} from "@domicile-desktop/sdk/app-element";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

import { css } from "../styled-system/css";
import { token } from "../styled-system/tokens";
import { AppWindow } from "./AppWindow";
import { CROSSING } from "./placement";
import { recordedSettles } from "./recorded-settles";
import { SlidingScreen } from "./sliding-screen";

// Records `focusApp` calls. Pointer mapping is the engine's, checked by
// `guard-app-routes-input.sh`.
const host = new FakeDomicileHost();

/** The windows this case asked the host to focus. */
const focused = (): unknown[] =>
  host.calls.filter(([method]) => method === "focusApp").map(([, id]) => id);

/** Where this case told the host each window is. */
const placed = (): unknown[] =>
  host.calls
    .filter(([method]) => method === "setAppBounds")
    .map(([, id, x, y, width, height]) => [id, { height, width, x, y }]);

/** The states this case asked the host to set on each window. */
const statesSet = (): unknown[] =>
  host.calls
    .filter(([method]) => method === "callSystem")
    .map(([, , request]) => JSON.parse(String(request)))
    .filter(({ call }) => call === "set_window_states")
    .map(({ app_id, states }) => [app_id, states]);

/** An arbitrary on-screen box. */
const ON_SCREEN = { height: 800, width: 1200, x: 0, y: 32 };

/** What a window off screen reports. */
const NO_BOX = { height: 0, width: 0, x: 0, y: 0 };

/** The box spanning title bar and contents. */
const FRAME = { height: 830, width: 1200, x: 0, y: 2 };

const nothingEnded = () => {
  // No test here needs the callback.
};

/**
 * The first duration in a `transition` or `animation` shorthand. Lets tests
 * compare durations without hard-coding them.
 */
const lengthOf = (shorthand: string): string => {
  const found = /\d+m?s/.exec(shorthand);
  if (found === null) {
    throw new Error(`test: no length in ${shorthand}`);
  } else {
    return found[0];
  }
};

/** Default props; each test overrides what it checks. */
const windowProps = {
  appId: "term",
  // Panel behavior is tested in `Shell.test.tsx`, with the launcher.
  behindPanel: false,
  clickThrough: false,
  cursor: undefined,
  depth: 0,
  domicile: host.domicile,
  dragging: false,
  floating: false,
  frame: FRAME,
  fullscreen: false,
  hasKeyboard: false,
  motion: "resting",
  onMotionEnded: nothingEnded,
  popups: [],
  rect: ON_SCREEN,
  resizing: false,
  syncedFrame: 0,
} as const;

// Loads the real stylesheet so computed styles reflect the emitted CSS.
loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

const portal = (container: HTMLElement): Element => {
  const element = container.querySelector(APP_TAG_NAME);
  if (element === null) {
    throw new Error("test: the app window rendered no element");
  } else {
    return element;
  }
};

/** Whether the `<app>` is resizing, and the size it is kept at. */
const shownAt = (container: HTMLElement) => {
  const app = portal(container);
  const { blockSize, inlineSize } = (app as HTMLElement).style;
  return {
    resizing: app.hasAttribute("resizing"),
    size: [blockSize, inlineSize],
  };
};

/** The box around the `<app>` that places, eases and clips it. */
const windowBox = (container: HTMLElement): HTMLElement => {
  const element = portal(container).parentElement;
  if (element === null) {
    throw new Error("test: the app window rendered no box around it");
  } else {
    return element;
  }
};

beforeEach(() => {
  host.calls.length = 0;
});

describe("AppWindow", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself and its popups to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <AppWindow
          {...windowProps}
          focused={false}
          motion="leaving-to-start"
          popups={[
            {
              appId: "menu",
              cursor: "default",
              frame: 0,
              rect: { height: 240, width: 180, x: 12, y: 30 },
            },
          ]}
        />
      </SlidingScreen>,
    );
    const layer = container.querySelector('[app-id="menu"]')?.parentElement;

    expect(windowBox(container).style.clip).toBe(
      "rect(-32px, 1280px, 968px, 0px)",
    );
    expect(layer?.style.clip).toBe("rect(-32px, 1280px, 968px, 0px)");
  });

  it("shows the synced frame it is given", () => {
    const { container } = render(
      <AppWindow {...windowProps} focused syncedFrame={4} />,
    );

    expect(portal(container).getAttribute("frame")).toBe("4");
  });

  it("leaves its frame the resting color even while it is focused", () => {
    // Focus is shown by a glow around the window (see `FocusGlow`), not a
    // border.
    const { container } = render(<AppWindow {...windowProps} focused />);

    expect(windowBox(container).className).toContain(
      css({ borderColor: "borderStrong" }),
    );
  });

  it("rounds its bottom corners, and leaves its top ones to the bar", () => {
    const { container } = render(<AppWindow {...windowProps} focused />);
    const style = globalThis.getComputedStyle(windowBox(container));

    expect(style.borderEndStartRadius).not.toBe("");
    expect(style.borderEndEndRadius).not.toBe("");
    // A top radius would cut a notch under the title bar.
    expect(style.borderStartStartRadius).toBe("");
    expect(style.borderStartEndRadius).toBe("");
  });

  it("squares its corners and drops its edge while it fills the screen", () => {
    const { container } = render(
      <AppWindow {...windowProps} focused fullscreen />,
    );
    const style = globalThis.getComputedStyle(windowBox(container));

    expect(style.borderEndStartRadius).toBe("");
    expect(style.borderEndEndRadius).toBe("");
    // No edge at the screen border.
    expect(style.borderTopWidth).not.toBe("1px");
  });

  it("mounts an element carrying the host's app id", () => {
    const { container } = render(<AppWindow {...windowProps} focused />);
    expect(portal(container).getAttribute("app-id")).toBe("term");
  });

  it("answers a click on the window itself rather than letting the engine", () => {
    // The shell owns focus. If the engine moved the keyboard, the shell would
    // still draw the previous window as focused.
    const { container } = render(
      <AppWindow {...windowProps} focused={false} />,
    );

    // What the engine dispatches for a press, and grants if it stands.
    const stood = portal(container).dispatchEvent(
      new CustomEvent(APP_FOCUS_REQUESTED_EVENT, {
        bubbles: true,
        cancelable: true,
        detail: { appId: "term" },
      }),
    );

    // Focus moves only when the `focused` prop changes.
    expect(stood).toBe(false);
  });

  it("hides the element when the window is not on screen", () => {
    const { container } = render(
      <AppWindow {...windowProps} focused={false} rect={undefined} />,
    );
    expect(windowBox(container)).not.toBeVisible();
  });

  it("gives the keyboard to the window the shell says is focused", () => {
    // Covers focus without a click, such as a newly opened or raised window.
    render(<AppWindow {...windowProps} focused />);
    expect(focused()).toStrictEqual(["term"]);
  });

  it("says nothing while the window already has the keyboard", () => {
    // Otherwise each `focus_changed` reply would trigger another request.
    render(<AppWindow {...windowProps} focused hasKeyboard />);
    expect(focused()).toStrictEqual([]);
  });

  it("says so again when the keyboard has gone somewhere else", () => {
    // A press on chrome moves the keyboard to the page without changing the
    // shell's focused window. The window must reclaim it.
    const { rerender } = render(
      <AppWindow {...windowProps} focused hasKeyboard />,
    );
    // Ignore the request made on mount.
    host.calls.length = 0;

    rerender(<AppWindow {...windowProps} focused hasKeyboard={false} />);

    expect(focused()).toStrictEqual(["term"]);
  });

  it("does not ask for the keyboard for a window the shell has not named", () => {
    // There is no "unfocus" request; the keyboard always belongs to someone.
    render(<AppWindow {...windowProps} focused={false} />);
    expect(focused()).toStrictEqual([]);
  });

  it("tells the compositor where it is each time it moves", () => {
    // The client draws at the scale of the monitor under it.
    const moved = { ...ON_SCREEN, x: 1920 };
    const { rerender } = render(<AppWindow {...windowProps} focused={false} />);
    rerender(
      <AppWindow {...windowProps} focused={false} rect={{ ...ON_SCREEN }} />,
    );
    rerender(<AppWindow {...windowProps} focused={false} rect={moved} />);

    expect(placed()).toStrictEqual([
      ["term", ON_SCREEN],
      ["term", moved],
    ]);
  });

  // An empty box tells the compositor to stop the client drawing.
  it("tells the compositor a window off screen has no box", () => {
    const { rerender } = render(<AppWindow {...windowProps} focused={false} />);
    rerender(<AppWindow {...windowProps} focused={false} rect={undefined} />);

    expect(placed()).toStrictEqual([
      ["term", ON_SCREEN],
      ["term", NO_BOX],
    ]);
  });

  it("shows the cursor the client asked for", () => {
    const { container } = render(
      <AppWindow {...windowProps} cursor="text" focused={false} />,
    );
    expect(portal(container)).toHaveStyle({ cursor: "text" });
  });

  describe("its popups", () => {
    const MENU = {
      appId: "menu",
      cursor: "default",
      frame: 0,
      rect: { height: 240, width: 180, x: 12, y: 30 },
    };

    /** The `<app>` of the popup `appId`. */
    const popupElement = (container: HTMLElement, appId: string): Element => {
      const element = container.querySelector(`[app-id="${appId}"]`);
      if (element === null) {
        throw new Error(`test: no popup ${appId}`);
      } else {
        return element;
      }
    };

    // Firefox draws its whole window into one, so it must slide, open and
    // close with the window.
    it("are drawn over it, playing its motion", () => {
      const { container } = render(
        <AppWindow
          {...windowProps}
          depth={4}
          focused={false}
          motion="arriving-from-end"
          popups={[MENU]}
        />,
      );
      const layer = popupElement(container, "menu").parentElement;

      expect(layer).toHaveAttribute("data-motion", "arriving-from-end");
      expect(layer).toHaveStyle({
        insetBlockStart: "32px",
        insetInlineStart: "0px",
        zIndex: "5",
      });
      expect(popupElement(container, "menu")).toHaveStyle({
        insetBlockStart: "30px",
        insetInlineStart: "12px",
      });
    });

    it("are not drawn while the window is off screen", () => {
      const { container } = render(
        <AppWindow
          {...windowProps}
          focused={false}
          popups={[MENU]}
          rect={undefined}
        />,
      );

      expect(container.querySelector('[app-id="menu"]')).toBeNull();
    });
  });

  describe("the way it moves", () => {
    it("plays the motion it is given", () => {
      // Animates a transform so the client is not resized each frame. See
      // the keyframes in `panda.config.ts`.
      const { container } = render(
        <AppWindow {...windowProps} focused={false} motion="opening" />,
      );

      expect(
        globalThis.getComputedStyle(windowBox(container)).animation,
      ).toContain("windowOpening");
    });

    // Its scaled edge alone is too faint to show it over a like tab, such as
    // a terminal opened over a terminal. The edge fades, so it never comes or
    // goes in one frame.
    it.each([
      ["opening-tab", "windowOpeningTabEdge"],
      ["closing-tab", "windowClosingTabEdge"],
    ] as const)("carries a fading edge and shadow while %s", (motion, edge) => {
      const { container } = render(
        <AppWindow {...windowProps} focused={false} motion={motion} />,
      );

      expect(
        globalThis.getComputedStyle(windowBox(container)).animationName,
      ).toContain(edge);
    });

    // The contents and title bar are separate elements. Each must scale about
    // the same point or they would separate.
    it("turns about the middle of its whole frame rather than its own", () => {
      const { container } = render(
        <AppWindow {...windowProps} focused={false} motion="opening" />,
      );

      // The frame's middle is (600, 417), 385px below the contents' top at
      // y = 32.
      expect(windowBox(container)).toHaveStyle({
        transformOrigin: "600px 385px",
      });
    });

    // Neighbors ease into the closing window's box, so the close animation
    // must not outlast that transition.
    it("leaves in the time the layout takes to close over it", () => {
      const { container } = render(
        <AppWindow {...windowProps} focused={false} motion="closing" />,
      );
      const style = globalThis.getComputedStyle(windowBox(container));

      expect(lengthOf(style.animation)).toBe(lengthOf(style.transition));
    });

    // Resizing the box every frame would have the client draw at every size
    // in between; see `useSettling`.
    it("takes its new box at once, and eases into it from the old one", () => {
      const { played, settler } = recordedSettles();
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} settler={settler} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, width: 600 }}
          settler={settler}
        />,
      );

      expect(
        globalThis.getComputedStyle(windowBox(container)).transition,
      ).not.toContain("inline-size");
      expect(played).toStrictEqual([{ scaleX: 2, scaleY: 1, x: 600, y: 0 }]);
    });

    // Tiled strips share its depth and come later in the page.
    it("eases into another group over the strips it passes", () => {
      const { held, settler } = recordedSettles();
      const { rerender } = render(
        <AppWindow {...windowProps} focused={false} settler={settler} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          crossing
          focused={false}
          rect={{ ...ON_SCREEN, width: 600 }}
          settler={settler}
        />,
      );

      expect(held).toStrictEqual([CROSSING]);
    });

    // The client draws at its new size before the box gets there, so scaling
    // its surface with the box would stretch its pixels. The box clips it
    // instead, and it keeps to the box's top left corner.
    it("crops its contents to the easing box rather than stretching them", () => {
      const { kept, settler } = recordedSettles();
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} settler={settler} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, width: 600 }}
          settler={settler}
        />,
      );

      expect(kept).toStrictEqual([[portal(container)]]);
      expect(globalThis.getComputedStyle(windowBox(container)).overflow).toBe(
        "clip",
      );
      expect(
        globalThis.getComputedStyle(portal(container)).transformOrigin,
      ).toBe("0 0");
    });

    // A shrinking box is drawn bigger than the client's new size at first, so
    // the client keeps its old size, cropped, and no gap opens inside the box.
    // `resizing` has the engine show each frame at its own size without
    // holding the page, so the ease starts at once and nothing stretches.
    it("keeps the client at its old size until a shrinking box settles", () => {
      const { ends, settler } = recordedSettles();
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} settler={settler} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, height: 700, width: 600 }}
          settler={settler}
        />,
      );
      const settling = shownAt(container);
      act(() => {
        ends[0]?.();
      });

      expect(settling).toStrictEqual({
        resizing: true,
        size: ["calc(100% + 100px)", "calc(100% + 600px)"],
      });
      expect(shownAt(container)).toStrictEqual({
        resizing: false,
        size: ["", ""],
      });
    });

    it("stops resizing once the box's ease has played", async () => {
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, width: 600 }}
        />,
      );
      const { resizing } = shownAt(container);
      for (const animation of windowBox(container).getAnimations()) {
        animation.finish();
      }

      expect(resizing).toBe(true);
      await waitFor(() => {
        expect(shownAt(container)).toStrictEqual({
          resizing: false,
          size: ["", ""],
        });
      });
    });

    // A window on another workspace was not drawn, so its client draws
    // again as the switch slides it in. The desk must not wait for it.
    it("shows its client's latest frame as it slides in", () => {
      const { container } = render(
        <AppWindow
          {...windowProps}
          focused={false}
          motion="arriving-from-end"
        />,
      );
      expect(shownAt(container).resizing).toBe(true);
    });

    it("gives a growing box's client its new size at once", () => {
      const { settler } = recordedSettles();
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} settler={settler} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, height: 900, width: 1500 }}
          settler={settler}
        />,
      );

      expect(shownAt(container)).toStrictEqual({
        resizing: true,
        size: ["", ""],
      });
    });

    // Each `z-index` change restacks the client's surface, so the depth never
    // steps through the ones between. A window leaving fullscreen stays over
    // the windows it covers until it has shrunk.
    it("takes a higher depth at once, and a lower one once it has settled", () => {
      const { container, rerender } = render(
        <AppWindow {...windowProps} depth={0} focused={false} />,
      );
      const transition = () =>
        globalThis.getComputedStyle(windowBox(container)).transition;

      rerender(<AppWindow {...windowProps} depth={2000} focused={false} />);
      expect(transition()).not.toContain("z-index");

      rerender(<AppWindow {...windowProps} depth={0} focused={false} />);
      expect(transition()).toContain("z-index");
      expect(transition()).toContain("step-end");
    });

    // `scale` applies outside the motion's `transform`, so it would scale the
    // motion's travel and pull the contents off their title bar.
    it("takes its new box without easing while it plays a motion", () => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <AppWindow
          {...windowProps}
          focused={false}
          motion="opening"
          settler={settler}
        />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          motion="opening"
          rect={{ ...ON_SCREEN, x: 40 }}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([undefined]);
    });

    // Its title bar's transitions take the shortest duration then.
    it("eases as briefly as reduced motion asks", () => {
      document.documentElement.toggleAttribute("data-reduced-motion", true);
      const { container, rerender } = render(
        <AppWindow {...windowProps} focused={false} />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          focused={false}
          rect={{ ...ON_SCREEN, x: 40 }}
        />,
      );
      document.documentElement.toggleAttribute("data-reduced-motion", false);

      expect(
        windowBox(container).getAnimations()[0]?.effect?.getTiming().duration,
      ).toBe(Number.parseInt(token("durations.fastest"), 10));
    });

    it("follows the pointer exactly while it is being dragged", () => {
      // Easing would make the window trail the pointer.
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <AppWindow
          {...windowProps}
          dragging
          focused={false}
          settler={settler}
        />,
      );

      rerender(
        <AppWindow
          {...windowProps}
          dragging
          focused={false}
          rect={{ ...ON_SCREEN, x: 40 }}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([undefined]);
    });

    it("stays opaque while it is being dragged", () => {
      const { container } = render(
        <AppWindow {...windowProps} dragging focused={false} />,
      );

      // Unset, so it draws at full opacity.
      expect(globalThis.getComputedStyle(windowBox(container)).opacity).toBe(
        "",
      );
    });

    it("says when it has played its motion out", async () => {
      await new Promise<void>((resolve) => {
        const { container } = render(
          <AppWindow
            {...windowProps}
            focused={false}
            motion="closing"
            onMotionEnded={() => {
              resolve();
            }}
          />,
        );
        fireEvent.animationEnd(windowBox(container));
      });
    });
  });

  // A leaving window must not take the keyboard back from the next window.
  describe("while it is leaving", () => {
    it("does not ask for the keyboard it had", () => {
      render(<AppWindow {...windowProps} focused motion="closing" />);

      expect(focused()).toStrictEqual([]);
    });

    it("takes no pointer, and is nothing a keyboard can reach", () => {
      const { container } = render(
        <AppWindow
          {...windowProps}
          focused={false}
          motion="leaving-to-start"
        />,
      );

      expect(
        globalThis.getComputedStyle(windowBox(container)).pointerEvents,
      ).toBe("none");
      expect(windowBox(container)).toHaveAttribute("inert");
    });
  });

  // Tiled states keep a client from drawing its own shadow, rounded corners
  // and resize border inside its tile.
  describe("the states it sets on its client", () => {
    it("are tiled on every edge while it tiles", () => {
      render(<AppWindow {...windowProps} focused={false} />);

      expect(statesSet()).toStrictEqual([
        ["term", ["tiled_left", "tiled_right", "tiled_top", "tiled_bottom"]],
      ]);
    });

    it("are none while it floats", () => {
      render(<AppWindow {...windowProps} floating focused={false} />);

      expect(statesSet()).toStrictEqual([["term", []]]);
    });

    it("are fullscreen while it fills the screen", () => {
      render(
        <AppWindow {...windowProps} floating focused={false} fullscreen />,
      );

      expect(statesSet()).toStrictEqual([["term", ["fullscreen"]]]);
    });
  });
});
