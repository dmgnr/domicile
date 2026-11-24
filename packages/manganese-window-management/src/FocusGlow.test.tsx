import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { fireEvent, render } from "@testing-library/react";

import { css } from "../styled-system/css";
import { FocusGlow } from "./FocusGlow";
import { recordedSettles } from "./recorded-settles";
import { SlidingScreen } from "./sliding-screen";

// Loads the real stylesheet so motion and settling styles resolve.
loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

/** A group of two windows, title bars included. */
const RECT = { height: 830, width: 1200, x: 20, y: 52 };

/** Default props; each test overrides what it checks. */
const glowProps = {
  depth: 0,
  dragging: false,
  leaving: false,
  motion: "resting",
  onFaded: () => undefined,
  rect: RECT,
  windows: ["app:term", "app:editor"],
} as const;

/** A `transitionend`; happy-dom's `TransitionEvent` drops `propertyName`. */
const transitionEnd = (propertyName: string): Event =>
  Object.assign(new Event("transitionend", { bubbles: true }), {
    propertyName,
  });

const glow = (container: HTMLElement): HTMLElement => {
  const element = container.firstElementChild;
  if (element instanceof HTMLElement) {
    return element;
  } else {
    throw new Error("test: the glow rendered no element");
  }
};

describe("FocusGlow", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <FocusGlow {...glowProps} motion="leaving-to-start" />
      </SlidingScreen>,
    );

    expect(glow(container).style.clip).toBe(
      "rect(-52px, 1260px, 948px, -20px)",
    );
  });

  it("rings its box in the accent, thicker in light mode, and glows into the gaps around it", () => {
    const { container } = render(<FocusGlow {...glowProps} />);

    expect(glow(container).className).toContain(
      css({
        boxShadow: {
          _light:
            "0 0 0 {spacing.0.75} {colors.accent}, 0 0 0 {spacing.1.25} color-mix(in oklab, {colors.accent} 35%, {colors.background}), 0 0 {spacing.6} {spacing.1.5} color-mix(in oklab, {colors.accent} 50%, transparent), {shadows.lifted}",
          base: "0 0 0 1px color-mix(in oklab, {colors.accent} 70%, transparent), 0 0 {spacing.9} color-mix(in oklab, {colors.accent} 45%, transparent), {shadows.lifted}",
        },
      }),
    );
  });

  it("names the windows it lights", () => {
    const { container } = render(<FocusGlow {...glowProps} />);

    expect(glow(container)).toHaveAttribute(
      "data-focus-box",
      "app:term app:editor",
    );
  });

  it("takes no pointer from the windows under it", () => {
    const { container } = render(<FocusGlow {...glowProps} />);

    expect(globalThis.getComputedStyle(glow(container)).pointerEvents).toBe(
      "none",
    );
  });

  it("covers its box at the depth of the windows it lights", () => {
    const { container } = render(<FocusGlow {...glowProps} depth={3} />);

    expect(glow(container)).toHaveStyle({
      blockSize: "830px",
      inlineSize: "1200px",
      insetBlockStart: "52px",
      insetInlineStart: "20px",
      zIndex: "3",
    });
  });

  // Focus follows the pointer, so a glow that slid to the next window would
  // chase it around the screen. Each box fades in and out where it is.
  describe("fading", () => {
    it("fades in from nothing", () => {
      const { container } = render(<FocusGlow {...glowProps} />);

      expect(glow(container).className).toContain(
        css({ _starting: { opacity: 0 } }),
      );
      expect(globalThis.getComputedStyle(glow(container)).opacity).toBe("1");
    });

    it("fades out where it is once focus leaves", () => {
      const { container } = render(<FocusGlow {...glowProps} leaving />);

      expect(glow(container)).toHaveAttribute("data-leaving");
      expect(globalThis.getComputedStyle(glow(container)).opacity).toBe("0");
      expect(globalThis.getComputedStyle(glow(container)).transition).toContain(
        "opacity",
      );
    });

    // A faded glow would stay mounted, drawing nothing.
    it("says when it has faded", async () => {
      await new Promise<void>((resolve) => {
        const { container } = render(
          <FocusGlow {...glowProps} leaving onFaded={resolve} />,
        );
        fireEvent(glow(container), transitionEnd("opacity"));
      });
    });

    // A lowered glow's depth also ends a transition.
    it("says nothing when another of its transitions ends", () => {
      const faded: string[] = [];
      const { container } = render(
        <FocusGlow
          {...glowProps}
          leaving
          onFaded={() => {
            faded.push("faded");
          }}
        />,
      );

      fireEvent(glow(container), transitionEnd("z-index"));

      expect(faded).toStrictEqual([]);
    });
  });

  // Otherwise the glow would be left behind around an empty box.
  it("plays the motion of the window it lights, about its own middle", () => {
    const { container } = render(<FocusGlow {...glowProps} motion="opening" />);

    expect(globalThis.getComputedStyle(glow(container)).animation).toContain(
      "windowOpening",
    );
    expect(glow(container)).toHaveStyle({ transformOrigin: "600px 415px" });
  });

  it("shuffles with its window when that window trades places in the stack", () => {
    const { container } = render(
      <FocusGlow
        {...glowProps}
        motion="restacking"
        restack={{ away: { x: 40, y: 0 }, from: 1, id: "app:term", to: 2 }}
      />,
    );

    expect(glow(container).style.getPropertyValue("--restack-to")).toBe("2");
  });

  describe("moved to a new box", () => {
    const moved = (dragging: boolean) => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <FocusGlow {...glowProps} dragging={dragging} settler={settler} />,
      );
      rerender(
        <FocusGlow
          {...glowProps}
          dragging={dragging}
          rect={{ ...glowProps.rect, x: glowProps.rect.x + 100 }}
          settler={settler}
        />,
      );
      return played;
    };

    it("eases there with its windows", () => {
      expect(moved(false)).toStrictEqual([
        { scaleX: 1, scaleY: 1, x: -100, y: 0 },
      ]);
    });

    it("follows its window exactly while that window is being dragged", () => {
      expect(moved(true)).toStrictEqual([undefined]);
    });
  });
});
