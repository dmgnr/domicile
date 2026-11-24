import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { render } from "@testing-library/react";

import { css } from "../styled-system/css";
import { recordedSettles } from "./recorded-settles";
import { SelectionTint } from "./SelectionTint";
import { SlidingScreen } from "./sliding-screen";

// Loads the real stylesheet so motion and settling styles resolve.
loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

/** A selected group of two windows, title bars included. */
const RECT = { height: 830, width: 1200, x: 20, y: 52 };

/** Default props; each test overrides what it checks. */
const tintProps = {
  depth: 0,
  dragging: false,
  motion: "resting",
  rect: RECT,
} as const;

const tint = (container: HTMLElement): HTMLElement => {
  const element = container.firstElementChild;
  if (element instanceof HTMLElement) {
    return element;
  } else {
    throw new Error("test: the tint rendered no element");
  }
};

describe("SelectionTint", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <SelectionTint {...tintProps} motion="leaving-to-start" />
      </SlidingScreen>,
    );

    expect(tint(container).style.clip).toBe(
      "rect(-52px, 1260px, 948px, -20px)",
    );
  });

  it("washes its box in the accent", () => {
    const { container } = render(<SelectionTint {...tintProps} />);

    expect(tint(container).className).toContain(
      css({
        backgroundColor:
          "color-mix(in oklab, {colors.accent} 15%, transparent)",
      }),
    );
  });

  // It lies over the windows, so a press must still reach them.
  it("takes no pointer from the windows under it", () => {
    const { container } = render(<SelectionTint {...tintProps} />);

    expect(globalThis.getComputedStyle(tint(container)).pointerEvents).toBe(
      "none",
    );
  });

  it("covers its box at the depth of the windows it tints", () => {
    const { container } = render(<SelectionTint {...tintProps} depth={3} />);

    expect(tint(container)).toHaveStyle({
      blockSize: "830px",
      inlineSize: "1200px",
      insetBlockStart: "52px",
      insetInlineStart: "20px",
      zIndex: "3",
    });
  });

  it("fades in from nothing", () => {
    const { container } = render(<SelectionTint {...tintProps} />);

    expect(tint(container).className).toContain(
      css({ _starting: { opacity: 0 } }),
    );
  });

  it("plays the motion of the window it tints, about its own middle", () => {
    const { container } = render(
      <SelectionTint {...tintProps} motion="opening" />,
    );

    expect(globalThis.getComputedStyle(tint(container)).animation).toContain(
      "windowOpening",
    );
    expect(tint(container)).toHaveStyle({ transformOrigin: "600px 415px" });
  });

  it("shuffles with its window when that window trades places in the stack", () => {
    const { container } = render(
      <SelectionTint
        {...tintProps}
        motion="restacking"
        restack={{ away: { x: 40, y: 0 }, from: 1, id: "app:term", to: 2 }}
      />,
    );

    expect(tint(container).style.getPropertyValue("--restack-to")).toBe("2");
  });

  describe("moved to a new box", () => {
    const moved = (dragging: boolean) => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <SelectionTint {...tintProps} dragging={dragging} settler={settler} />,
      );
      rerender(
        <SelectionTint
          {...tintProps}
          dragging={dragging}
          rect={{ ...tintProps.rect, x: tintProps.rect.x + 100 }}
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

    it("follows its windows exactly while they are being dragged", () => {
      expect(moved(true)).toStrictEqual([undefined]);
    });
  });
});
