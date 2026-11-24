import { describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { fireEvent, render, screen } from "@testing-library/react";
import { css } from "../styled-system/css";
import { recordedSettles } from "./recorded-settles";
import { SettleHandoffs } from "./SettleHandoffs";
import { SlidingScreen } from "./sliding-screen";
import { TabStrip } from "./TabStrip";

loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

/** A tabbed strip of two 240px tabs, along the top of its group. */
const BOX = { height: 30, width: 1000, x: 100, y: 50 };
const END = { height: 30, width: 520, x: 580, y: 50 };
/** The group's whole box, which the strip turns about with it. */
const FRAME = { height: 600, width: 1000, x: 100, y: 50 };

const nothing = () => undefined;

const stripProps = {
  box: BOX,
  depth: 2,
  dragging: false,
  end: END,
  endDivided: false,
  float: undefined,
  frame: FRAME,
  fullscreen: false,
  group: { node: { id: "a", up: 1 }, wells: 0, windows: ["a", "b"] },
  motion: "resting",
  nested: false,
  onAim: nothing,
  onDrop: nothing,
  onDropOn: nothing,
  onFloat: nothing,
  onFullscreen: nothing,
  onGrab: nothing,
  onHover: nothing,
  onMove: nothing,
  onNewTab: nothing,
  onPull: nothing,
  targets: { floats: [], screens: [], tabs: [], windows: [] },
} as const;

const stripOf = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>("[data-strip]");
  if (element === null) {
    throw new Error("test: the strip rendered no element");
  } else {
    return element;
  }
};

const partOf = (container: HTMLElement, selector: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`test: the strip drew no ${selector}`);
  } else {
    return element;
  }
};

const parentOf = (element: HTMLElement): HTMLElement => {
  const parent = element.parentElement;
  if (parent === null) {
    throw new Error("test: the element has no parent");
  } else {
    return parent;
  }
};

describe("TabStrip", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <TabStrip {...stripProps} motion="leaving-to-start" />
      </SlidingScreen>,
    );

    expect(stripOf(container).style.clip).toBe(
      "rect(-50px, 1180px, 950px, -100px)",
    );
  });

  // One box for the whole strip, so no seam shows between its tabs.
  it("draws the whole strip as one box at its group's depth", () => {
    const { container } = render(<TabStrip {...stripProps} />);

    expect(container.querySelectorAll("[data-strip]")).toHaveLength(1);
    expect(stripOf(container)).toHaveStyle({
      blockSize: "30px",
      inlineSize: "1000px",
      insetBlockStart: "50px",
      insetInlineStart: "100px",
      zIndex: "2",
    });
  });

  // The window's top row is tucked under the strip's bottom row, which draws
  // its edge. The open tab covers it to join its window.
  it("draws the window's top edge along its bottom", () => {
    const { container } = render(<TabStrip {...stripProps} />);

    expect(stripOf(container).className).toContain(
      css({ borderBlockEndWidth: "1px" }),
    );
  });

  it("draws its edge stronger inside another group's well", () => {
    const strong = css({
      "--strip-edge":
        "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
    });

    expect(
      stripOf(render(<TabStrip {...stripProps} nested />).container).className,
    ).toContain(strong);
    expect(
      stripOf(render(<TabStrip {...stripProps} />).container).className,
    ).not.toContain(strong);
  });

  // Focus follows the pointer onto the group's rail as onto its windows.
  it("reports where the pointer crossed into any part of it", () => {
    const crossed: (readonly [number, number])[] = [];
    const { container } = render(
      <TabStrip
        {...stripProps}
        onHover={(at) => {
          crossed.push(at);
        }}
      />,
    );

    fireEvent.pointerOver(partOf(container, "[data-group-handle]"), {
      clientX: 900,
      clientY: 60,
    });

    expect(crossed).toStrictEqual([[900, 60]]);
  });

  describe("moving with its group", () => {
    it("plays its group's motion about the group's middle", () => {
      const { container } = render(
        <TabStrip {...stripProps} motion="closing" />,
      );

      expect(
        globalThis.getComputedStyle(stripOf(container)).animation,
      ).toContain("windowClosing");
      // The group's middle is (600, 350), 300 below the strip's top.
      expect(stripOf(container)).toHaveStyle({
        transformOrigin: "500px 300px",
      });
    });

    // A tab switch only fades the windows, and a new tab opens out on the
    // strip; the strip stays.
    it.each(["opening-tab", "revealing"] as const)(
      "stays put while its open window is %s",
      (motion) => {
        const { played, settler } = recordedSettles();
        const { container, rerender } = render(
          <TabStrip {...stripProps} motion={motion} settler={settler} />,
        );
        rerender(
          <TabStrip
            {...stripProps}
            box={{ ...BOX, x: 50 }}
            end={{ ...END, x: 530 }}
            frame={{ ...FRAME, x: 50 }}
            motion={motion}
            settler={settler}
          />,
        );

        expect(globalThis.getComputedStyle(stripOf(container)).animation).toBe(
          "",
        );
        expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: 50, y: 0 }]);
      },
    );

    it("eases into a new box on the windows' timing", () => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <TabStrip {...stripProps} settler={settler} />,
      );

      rerender(
        <TabStrip
          {...stripProps}
          box={{ ...BOX, x: 50 }}
          end={{ ...END, x: 530 }}
          frame={{ ...FRAME, x: 50 }}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: 50, y: 0 }]);
    });

    // A tab switch inside a nested group hands both strips to new elements,
    // since the outer tab is named after the nested group's open window.
    it("takes over from its own group's strip, not the one around it", () => {
      const { played, settler } = recordedSettles();
      const inner = { ...BOX, width: 500, y: 90 };
      const strips = (open: string) => (
        <SettleHandoffs>
          <TabStrip
            {...stripProps}
            box={inner}
            group={{ node: { id: open, up: 1 }, wells: 1, windows: ["b", "c"] }}
            key={`inner-${open}`}
            nested
            settler={settler}
          />
          <TabStrip
            {...stripProps}
            group={{
              node: { id: open, up: 2 },
              wells: 0,
              windows: ["a", "b", "c"],
            }}
            key={`outer-${open}`}
            settler={settler}
          />
        </SettleHandoffs>
      );
      const { rerender } = render(strips("b"));

      rerender(strips("c"));

      expect(played).toStrictEqual([
        { scaleX: 1, scaleY: 1, x: 0, y: 0 },
        { scaleX: 1, scaleY: 1, x: 0, y: 0 },
      ]);
    });

    // A window moved out of a nested tab group draws the outer strip next,
    // which must not fly out of the well.
    it("takes over at its new depth when its window changes group", () => {
      const { played, settler } = recordedSettles();
      const inner = { ...BOX, width: 500, y: 90 };
      const { rerender } = render(
        <SettleHandoffs>
          <TabStrip
            {...stripProps}
            box={inner}
            group={{ node: { id: "c", up: 1 }, wells: 1, windows: ["b", "c"] }}
            key="c"
            nested
            settler={settler}
          />
          <TabStrip
            {...stripProps}
            group={{
              node: { id: "c", up: 2 },
              wells: 0,
              windows: ["a", "b", "c"],
            }}
            key="tab"
            settler={settler}
          />
        </SettleHandoffs>,
      );

      rerender(
        <SettleHandoffs>
          <TabStrip
            {...stripProps}
            group={{
              node: { id: "c", up: 1 },
              wells: 0,
              windows: ["a", "b", "c"],
            }}
            key="c"
            settler={settler}
          />
        </SettleHandoffs>,
      );

      expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: 0, y: 0 }]);
    });

    // The joining window opens and draws the group's strip next. Easing from
    // its old strip's box would leave the group without a strip meanwhile.
    it.each([
      ["after", ["a", "b", "c"]],
      ["before", ["c", "a", "b"]],
    ])(
      "takes over from the strip of a group its window joins %s its tabs",
      (_, windows) => {
        const { played, settler } = recordedSettles();
        const { rerender } = render(
          <SettleHandoffs>
            <TabStrip
              {...stripProps}
              group={{
                node: { id: "a", up: 1 },
                wells: 0,
                windows: ["a", "b"],
              }}
              key="a"
              settler={settler}
            />
            <TabStrip
              {...stripProps}
              box={{ ...BOX, y: 700 }}
              frame={{ ...FRAME, y: 700 }}
              group={{ node: { id: "c", up: 1 }, wells: 0, windows: ["c"] }}
              key="c"
              settler={settler}
            />
          </SettleHandoffs>,
        );

        rerender(
          <SettleHandoffs>
            <TabStrip
              {...stripProps}
              group={{ node: { id: "c", up: 1 }, wells: 0, windows }}
              key="c"
              settler={settler}
            />
          </SettleHandoffs>,
        );

        expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: 0, y: 0 }]);
      },
    );

    // A dragged float's strip would trail the pointer.
    it("follows its group exactly while the group is dragged", () => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <TabStrip {...stripProps} dragging settler={settler} />,
      );

      rerender(
        <TabStrip
          {...stripProps}
          box={{ ...BOX, x: 50 }}
          dragging
          end={{ ...END, x: 530 }}
          frame={{ ...FRAME, x: 50 }}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([undefined]);
    });

    it("takes no pointer or keyboard while its group leaves", () => {
      const { container } = render(
        <TabStrip {...stripProps} motion="closing" />,
      );

      expect(stripOf(container)).toHaveAttribute("inert");
    });
  });

  describe("its end", () => {
    it("offers a new tab just past the last tab", async () => {
      const added = new Promise<void>((resolve) => {
        const { container } = render(
          <TabStrip {...stripProps} onNewTab={resolve} />,
        );
        expect(partOf(container, "[data-new-tab]")).toHaveStyle({
          insetInlineStart: "480px",
        });
      });
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await added;
    });

    it("marks off the new-tab button from a hidden last tab", () => {
      expect(
        partOf(
          render(<TabStrip {...stripProps} endDivided />).container,
          "[data-new-tab]",
        ),
      ).toHaveAttribute("data-divided");
      expect(
        partOf(
          render(<TabStrip {...stripProps} />).container,
          "[data-new-tab]",
        ),
      ).not.toHaveAttribute("data-divided");
    });

    it("centers the new-tab button level with the group buttons", () => {
      const { container, getByRole } = render(<TabStrip {...stripProps} />);
      const newTab = globalThis.getComputedStyle(
        partOf(container, "[data-new-tab]"),
      );
      const buttons = globalThis.getComputedStyle(
        parentOf(getByRole("button", { name: "Float group" })),
      );

      expect(newTab.alignItems).toBe("center");
      expect([newTab.insetBlockStart, newTab.insetBlockEnd]).toStrictEqual([
        buttons.insetBlockStart,
        buttons.insetBlockEnd,
      ]);
    });

    it("holds the handle that drags the whole group", () => {
      const { container } = render(<TabStrip {...stripProps} />);

      expect(partOf(container, "[data-group-handle]")).toHaveStyle({
        inlineSize: "520px",
        insetInlineStart: "480px",
      });
    });

    it("floats the whole group", async () => {
      await new Promise<void>((resolve) => {
        const { getByRole } = render(
          <TabStrip {...stripProps} onFloat={resolve} />,
        );
        fireEvent.click(getByRole("button", { name: "Float group" }));
      });
    });

    it("fills the screen with the whole group", async () => {
      await new Promise<void>((resolve) => {
        const { getByRole } = render(
          <TabStrip {...stripProps} onFullscreen={resolve} />,
        );
        fireEvent.click(getByRole("button", { name: "Maximize group" }));
      });
    });

    // A stack's bars span the strip.
    it("is not there in a stack", () => {
      const { container, queryByRole } = render(
        <TabStrip {...stripProps} end={undefined} />,
      );

      expect(container.querySelector("[data-group-handle]")).toBeNull();
      expect(queryByRole("button", { name: "New tab" })).toBeNull();
      expect(queryByRole("button", { name: "Float group" })).toBeNull();
    });
  });
});
