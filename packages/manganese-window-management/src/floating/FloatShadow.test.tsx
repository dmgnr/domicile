import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { render } from "@testing-library/react";
import { recordedSettles } from "../recorded-settles";
import { SlidingScreen } from "../sliding-screen";
import { FloatShadow } from "./FloatShadow";

loadEmittedStylesheet(
  document,
  new URL("../../styled-system/styles.css", import.meta.url),
);

const shadow = (container: HTMLElement): Element => {
  const element = container.querySelector("[data-shadow]");
  if (element === null) {
    throw new Error("test: the shadow rendered no element");
  } else {
    return element;
  }
};

describe("FloatShadow", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <FloatShadow
          depth={0}
          dragging={false}
          frame={{ height: 300, width: 400, x: 20, y: 52 }}
          motion="leaving-to-start"
        />
      </SlidingScreen>,
    );

    expect((shadow(container) as HTMLElement).style.clip).toBe(
      "rect(-52px, 1260px, 948px, -20px)",
    );
  });

  it("stays opaque while its window is dragged", () => {
    const { container } = render(
      <FloatShadow
        depth={0}
        dragging
        frame={{ height: 300, width: 400, x: 20, y: 52 }}
        motion="resting"
      />,
    );

    // Unset, so it draws at full opacity.
    expect(globalThis.getComputedStyle(shadow(container)).opacity).toBe("");
  });

  // A blurred shadow moved within a shared layer repaints every frame.
  it("draws on a layer of its own while its window is dragged", () => {
    const willChange = (dragging: boolean) => {
      const { container, unmount } = render(
        <FloatShadow
          depth={0}
          dragging={dragging}
          frame={{ height: 300, width: 400, x: 20, y: 52 }}
          motion="resting"
        />,
      );
      const style = globalThis.getComputedStyle(shadow(container)).willChange;
      unmount();
      return style;
    };

    expect([willChange(true), willChange(false)]).toStrictEqual([
      "transform",
      "",
    ]);
  });

  it("moves with its window, following it exactly while it is dragged", () => {
    const frame = { height: 300, width: 400, x: 20, y: 52 };
    const played = (dragging: boolean) => {
      const settles = recordedSettles();
      const { rerender } = render(
        <FloatShadow
          depth={0}
          dragging={dragging}
          frame={frame}
          motion="resting"
          settler={settles.settler}
        />,
      );
      rerender(
        <FloatShadow
          depth={0}
          dragging={dragging}
          frame={{ ...frame, x: 120 }}
          motion="resting"
          settler={settles.settler}
        />,
      );
      return settles.played;
    };

    expect(played(false)).toStrictEqual([
      { scaleX: 1, scaleY: 1, x: -100, y: 0 },
    ]);
    expect(played(true)).toStrictEqual([undefined]);
  });

  // A scratchpad window hangs from the screen's top edge.
  it("squares its top corners while its window hangs", () => {
    const { container } = render(
      <FloatShadow
        depth={0}
        dragging={false}
        frame={{ height: 300, width: 400, x: 20, y: 0 }}
        hanging
        motion="resting"
      />,
    );
    const style = globalThis.getComputedStyle(shadow(container));

    expect(style.borderStartStartRadius).toBe("");
    expect(style.borderStartEndRadius).toBe("");
    expect(style.borderEndStartRadius).not.toBe("");
  });
});
