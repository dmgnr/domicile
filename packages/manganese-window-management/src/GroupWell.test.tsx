import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { render } from "@testing-library/react";

import { css } from "../styled-system/css";
import { GroupWell } from "./GroupWell";
import { SlidingScreen } from "./sliding-screen";

// Loads the real stylesheet so motion and settling styles resolve.
loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

/** The box under a strip, which a nested group sits in. */
const RECT = { height: 800, width: 1200, x: 20, y: 82 };

const wellProps = {
  castsShadow: false,
  depth: 0,
  dragging: false,
  motion: "resting",
  nested: false,
  rect: RECT,
} as const;

const well = (container: HTMLElement): HTMLElement => {
  const element = container.firstElementChild;
  if (element instanceof HTMLElement) {
    return element;
  } else {
    throw new Error("test: the well rendered no element");
  }
};

describe("GroupWell", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <GroupWell {...wellProps} motion="leaving-to-start" />
      </SlidingScreen>,
    );

    expect(well(container).style.clip).toBe(
      "rect(-82px, 1260px, 918px, -20px)",
    );
  });

  it("covers its box at the depth of the windows in it", () => {
    const { container } = render(<GroupWell {...wellProps} depth={3} />);

    expect(well(container)).toHaveStyle({
      blockSize: "800px",
      inlineSize: "1200px",
      insetBlockStart: "82px",
      insetInlineStart: "20px",
      zIndex: "3",
    });
  });

  it("matches the open tab it hangs from", () => {
    const { container } = render(<GroupWell {...wellProps} />);

    expect(well(container).className).toContain(
      css({
        backgroundColor:
          "color-mix(in oklab, {colors.foreground} 14%, {colors.background})",
      }),
    );
  });

  it("casts a float's shadow only when asked to", () => {
    const shadow = css({ boxShadow: "lifted" });

    expect(
      well(render(<GroupWell {...wellProps} castsShadow />).container)
        .className,
    ).toContain(shadow);
    expect(
      well(render(<GroupWell {...wellProps} />).container).className,
    ).not.toContain(shadow);
  });

  it("draws its edge stronger inside another group's well", () => {
    const strong = css({
      borderColor:
        "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
    });

    expect(
      well(render(<GroupWell {...wellProps} nested />).container).className,
    ).toContain(strong);
    expect(
      well(render(<GroupWell {...wellProps} />).container).className,
    ).not.toContain(strong);
  });

  // Its float's windows and tabs shuffle away; it moves with them.
  it("shuffles with its float", () => {
    const { container } = render(
      <GroupWell
        {...wellProps}
        motion="restacking"
        restack={{ away: { x: 40, y: 0 }, from: 1, id: "app:term", to: 2 }}
      />,
    );

    expect(well(container).style.getPropertyValue("--restack-to")).toBe("2");
  });

  it("takes no pointer from the windows in it", () => {
    const { container } = render(<GroupWell {...wellProps} />);

    expect(globalThis.getComputedStyle(well(container)).pointerEvents).toBe(
      "none",
    );
  });
});
