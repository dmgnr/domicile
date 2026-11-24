import { afterEach, describe, expect, it, mock } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import {
  drawAt,
  drawPopups,
  popupLeft,
  undrawPopups,
} from "@domicile-desktop/test-support/popup-layout";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { css } from "../styled-system/css";
import { CROSSING, raised } from "./placement";
import { recordedSettles } from "./recorded-settles";
import { SettleHandoffs } from "./SettleHandoffs";
import { SlidingScreen } from "./sliding-screen";
import { TitleBar } from "./TitleBar";
import type { StripPlace } from "./tree/frames";
import { Layout } from "./tree/node";

loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

/** The address bar's surface, which the bar or open tab above matches. */
const RAISED = "chrome";

/** The heavier look of the bar or tab being worked in. */
const FAUX_MEDIUM = css({
  WebkitTextStroke: "{borderWidths.fauxMedium} currentColor",
});

/** An arbitrary bar position. */
const ON_SCREEN = { height: 30, width: 1200, x: 0, y: 32 };

/** The window's whole box, which the bar scales about. */
const FRAME = { height: 830, width: 1200, x: 0, y: 32 };

/** Longer than base-ui's tooltip delay, 600 ms. */
const TOOLTIP_WAIT_MS = 800;

const nothingEnded = () => {
  // No case here plays an animation to its end.
};

/** Shared props; each case overrides the one it tests. */
const barProps = {
  depth: 0,
  dragging: false,
  floating: false,
  focus: "resting",
  frame: FRAME,
  fullscreen: false,
  motion: "resting",
  onClose: () => undefined,
  onFloat: () => undefined,
  onFullscreen: () => undefined,
  onMotionEnded: nothingEnded,
  rect: ON_SCREEN,
  title: "kitty",
  window: "app:term",
} as const;

const bar = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>("[data-window]");
  if (element === null) {
    throw new Error("test: the title bar rendered no element");
  } else {
    return element;
  }
};

/** The bar's own box, inside the slot `bar` returns. */
const face = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>("[data-face]");
  if (element === null) {
    throw new Error("test: the title bar rendered no face");
  } else {
    return element;
  }
};

/** One of the face's color layers. See `Fill` in `TitleBar`. */
const fill = (
  container: HTMLElement,
  layer: "hover" | "leaf" | "raised" | "rail",
): HTMLElement => {
  const element = face(container).querySelector<HTMLElement>(
    `:scope > [data-fill="${layer}"]`,
  );
  if (element === null) {
    throw new Error(`test: the face has no ${layer} layer`);
  } else {
    return element;
  }
};

/**
 * A transition of `opacity` alone: no comma outside an easing function's
 * arguments.
 */
const OPACITY_ONLY = /^opacity (?:[^,(]|\([^)]*\))*$/;

/** Whether a layer or copy shows, faded all the way in. */
const shows = (element: Element): boolean =>
  globalThis.getComputedStyle(element).opacity === "1";

/** The title's own text, under the copy it fades to. */
const plainTitle = (container: HTMLElement): HTMLElement => {
  const element = face(container).querySelector<HTMLElement>(
    "[data-title] > span",
  );
  if (element === null) {
    throw new Error("test: the face has no title");
  } else {
    return element;
  }
};

/** A tab's place in a strip, for cases about a tab. */
const MIDDLE_TAB = {
  area: { height: 830, width: 1000, x: 0, y: 0 },
  at: 1,
  box: { height: 30, width: 1000, x: 0, y: 0 },
  divided: false,
  end: { height: 30, width: 280, x: 720, y: 0 },
  endDivided: false,
  group: { node: { id: "a", up: 1 }, wells: 0, windows: ["a", "b", "c"] },
  nested: false,
  open: false,
  tabs: 3,
};

// The bar and the contents are separate elements, so they must animate
// identically or the window splits apart.
describe("TitleBar's icon", () => {
  const icon = (container: HTMLElement): Element => {
    const element = face(container).querySelector("[data-icon]");
    if (element === null) {
      throw new Error("test: the title bar drew no icon");
    } else {
      return element;
    }
  };

  it("draws the window's icon", () => {
    const { container } = render(
      <TitleBar {...barProps} icon="data:image/png;base64,AA==" />,
    );

    expect(icon(container).querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA==",
    );
  });

  // A page outside the default browser profile says so on its tab.
  it("marks the icon in the color it is given", () => {
    const { container } = render(<TitleBar {...barProps} mark="#d97706" />);

    expect(
      (icon(container).querySelector("[data-mark]") as HTMLElement | null)
        ?.style.backgroundColor,
    ).toBe("#d97706");
  });

  it("leaves the icon unmarked by default", () => {
    const { container } = render(<TitleBar {...barProps} />);

    expect(icon(container).querySelector("[data-mark]")).toBeNull();
  });

  // Every bar has an icon, so titles line up.
  it("draws a stand-in for a window with no icon", () => {
    const { container } = render(<TitleBar {...barProps} icon={undefined} />);

    expect(icon(container).querySelector("img")).toBeNull();
    expect(icon(container).querySelector("svg")).not.toBeNull();
  });

  // A page can link an icon that does not load.
  it("draws the stand-in when the icon does not load", () => {
    const { container } = render(
      <TitleBar {...barProps} icon="https://example.com/missing.png" />,
    );
    const image = icon(container).querySelector("img");
    if (image === null) {
      throw new Error("test: the title bar drew no image");
    }

    fireEvent.error(image);

    expect(icon(container).querySelector("img")).toBeNull();
    expect(icon(container).querySelector("svg")).not.toBeNull();
  });
});

describe("TitleBar", () => {
  // A float hanging off its screen would slide into view beside its
  // workspace.
  it("clips itself to its workspace while a switch slides it", () => {
    const { container } = render(
      <SlidingScreen value={{ height: 1000, width: 1280, x: 0, y: 0 }}>
        <TitleBar {...barProps} motion="leaving-to-start" />
      </SlidingScreen>,
    );

    expect(bar(container).style.clip).toBe("rect(-32px, 1280px, 968px, 0px)");
  });

  it("plays the motion the window it names is playing", () => {
    const { container } = render(<TitleBar {...barProps} motion="opening" />);

    expect(globalThis.getComputedStyle(bar(container)).animation).toContain(
      "windowOpening",
    );
  });

  it("turns about the middle of that window rather than its own", () => {
    const { container } = render(<TitleBar {...barProps} motion="opening" />);

    // The frame's middle is (600, 447), 415 below the top of the bar.
    expect(bar(container)).toHaveStyle({ transformOrigin: "600px 415px" });
  });

  // A tab collapses along its strip; the contents under it only fade.
  it("closes up across a tabbed container's strip", () => {
    const { container } = render(
      <TitleBar {...barProps} motion="closing-tab" tabbed={Layout.Tabbed} />,
    );

    expect(globalThis.getComputedStyle(bar(container)).animation).toContain(
      "windowClosingTab",
    );
    expect(bar(container).style.getPropertyValue("--collapse-x")).toBe("0");
  });

  // The tabs after it ease along on the same curve, so its end meets the next
  // tab's start throughout and the strip shows no gap.
  it.each(["closing-tab", "opening-tab"] as const)(
    "turns about the start of its strip while %s",
    (motion) => {
      const { container } = render(
        <TitleBar
          {...barProps}
          motion={motion}
          strip={MIDDLE_TAB}
          tabbed={Layout.Tabbed}
        />,
      );

      expect(bar(container)).toHaveStyle({ transformOrigin: "0px 0px" });
    },
  );

  // Sent away, it leaves as a window does, so it does not look closed.
  it("lifts out of its strip about its window's middle when sent away", () => {
    const { container } = render(
      <TitleBar
        {...barProps}
        motion="sending-tab"
        strip={MIDDLE_TAB}
        tabbed={Layout.Tabbed}
      />,
    );

    expect(globalThis.getComputedStyle(bar(container)).animation).toContain(
      "windowSending",
    );
    expect(bar(container)).toHaveStyle({ transformOrigin: "600px 415px" });
  });

  it("opens out along a tabbed container's strip", () => {
    const { container } = render(
      <TitleBar
        {...barProps}
        motion="opening-tab"
        strip={MIDDLE_TAB}
        tabbed={Layout.Tabbed}
      />,
    );

    expect(globalThis.getComputedStyle(bar(container)).animation).toContain(
      "windowOpeningTab",
    );
    expect(bar(container).style.getPropertyValue("--collapse-x")).toBe("0");
  });

  // A closing bar's buttons would do nothing.
  it("is nothing a pointer or a keyboard can reach while it leaves", () => {
    const { container } = render(<TitleBar {...barProps} motion="closing" />);

    expect(globalThis.getComputedStyle(bar(container)).pointerEvents).toBe(
      "none",
    );
    expect(bar(container)).toHaveAttribute("inert");
  });

  it("says when it has played that motion out", async () => {
    await new Promise<void>((resolve) => {
      const { container } = render(
        <TitleBar
          {...barProps}
          motion="closing"
          onMotionEnded={() => {
            resolve();
          }}
        />,
      );
      fireEvent.animationEnd(bar(container));
    });
  });

  describe("moved to a new box", () => {
    const AWAY = { ...ON_SCREEN, x: 100 };
    const moved = (props: Partial<Parameters<typeof TitleBar>[0]>) => {
      const { kept, played, settler } = recordedSettles();
      const rendered = render(
        <TitleBar {...barProps} {...props} settler={settler} />,
      );
      rendered.rerender(
        <TitleBar
          {...barProps}
          {...props}
          frame={{ ...FRAME, x: 100 }}
          rect={AWAY}
          settler={settler}
        />,
      );
      return { container: rendered.container, kept, played };
    };

    // On the contents' timing and the compositor's thread, so the bar keeps
    // with its window.
    it("eases there as its window's contents do", () => {
      const { container, played } = moved({});

      expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: -100, y: 0 }]);
      expect(
        globalThis.getComputedStyle(bar(container)).transition,
      ).not.toContain("inset-inline-start");
    });

    // Easing would make the bar trail the pointer. Colors still ease, since a
    // drag crosses many windows.
    it("goes there at once while its window is being dragged", () => {
      const { container, played } = moved({ dragging: true });

      expect(played).toStrictEqual([undefined]);
      expect(globalThis.getComputedStyle(bar(container)).transition).toContain(
        "background-color",
      );
    });

    // Its contents ease from under the whole strip. Grown from its slot, the
    // bar would leave the rest of the strip's row clear as it went.
    it("eases from its whole strip when it leaves a tabbed container", () => {
      const { played, settler } = recordedSettles();
      const strip = { ...MIDDLE_TAB, box: { ...ON_SCREEN, width: 1000 } };
      const { rerender } = render(
        <TitleBar
          {...barProps}
          rect={{ ...ON_SCREEN, width: 240, x: 240 }}
          settler={settler}
          strip={strip}
          tabbed={Layout.Tabbed}
        />,
      );

      rerender(
        <TitleBar
          {...barProps}
          frame={{ ...FRAME, width: 500, x: 500 }}
          rect={{ ...ON_SCREEN, width: 500, x: 500 }}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([{ scaleX: 2, scaleY: 1, x: -250, y: 0 }]);
    });

    // Over its window's contents, which hold `CROSSING` as they go.
    it("eases its open tab into another group over the strips it passes", () => {
      const { held, settler } = recordedSettles();
      const strip = { ...MIDDLE_TAB, open: true };
      const { rerender } = render(
        <TitleBar {...barProps} settler={settler} strip={strip} />,
      );

      rerender(
        <TitleBar
          {...barProps}
          crossing
          rect={{ ...ON_SCREEN, width: 500, x: 500 }}
          settler={settler}
          strip={strip}
        />,
      );

      expect(held).toStrictEqual([raised(CROSSING)]);
    });

    it("goes there at once while it plays a motion", () => {
      expect(moved({ motion: "opening" }).played).toStrictEqual([undefined]);
    });

    // Scaling text and icons would stretch them.
    it("keeps its title and buttons at their own size as it eases", () => {
      const upright = moved({}).kept[0] ?? [];

      expect(
        upright.some((part) => part.contains(screen.getByText("kitty"))),
      ).toBe(true);
      expect(
        upright.some((part) =>
          part.contains(screen.getByRole("button", { name: "Close" })),
        ),
      ).toBe(true);
    });
  });

  // It stays over the windows its window still covers until it has shrunk.
  it("keeps a lower depth's old one until it has settled", () => {
    const { container, rerender } = render(
      <TitleBar {...barProps} depth={2000} />,
    );
    const transition = () =>
      globalThis.getComputedStyle(bar(container)).transition;
    expect(transition()).not.toContain("z-index");

    rerender(<TitleBar {...barProps} depth={0} />);

    expect(transition()).toContain("z-index");
    expect(transition()).toContain("step-end");
  });

  it("shows a grabbing pointer while its window is being moved", () => {
    const { container } = render(<TitleBar {...barProps} grabbing />);

    expect(globalThis.getComputedStyle(bar(container)).cursor).toBe("grabbing");
  });

  // Focus follows the cursor, so these colors change often and would flicker
  // without easing. They fade by opacity, which the compositor eases without
  // painting the bar again; easing a color paints it on every frame.
  it("fades between the colors that say where the keyboard is without painting", () => {
    const { container } = render(<TitleBar {...barProps} />);

    for (const layer of ["hover", "leaf", "raised", "rail"] as const) {
      expect(
        globalThis.getComputedStyle(fill(container, layer)).transition,
      ).toMatch(OPACITY_ONLY);
    }
    expect(
      globalThis.getComputedStyle(plainTitle(container)).transition,
    ).toMatch(OPACITY_ONLY);
    expect(
      globalThis.getComputedStyle(face(container)).transition,
    ).not.toContain("color");
  });

  it("brightens the title of the window being worked in", () => {
    const focused = render(<TitleBar {...barProps} focus="focused" />);
    expect(shows(plainTitle(focused.container))).toBe(false);

    const resting = render(<TitleBar {...barProps} />);
    expect(shows(plainTitle(resting.container))).toBe(true);
  });

  it("sets the name of the window being worked in in a heavier face", () => {
    // Weight as well as color, for users who cannot tell the colors apart.
    const focused = render(<TitleBar {...barProps} focus="focused" />);
    expect(face(focused.container).className).toContain(FAUX_MEDIUM);

    const resting = render(<TitleBar {...barProps} />);
    expect(face(resting.container).className).not.toContain(FAUX_MEDIUM);
  });

  it("keeps the name of the window being worked in as wide as any other", () => {
    // A wider face would push the title's letters sideways on focus.
    for (const focus of ["focused", "leaf", "resting", "selected"] as const) {
      const own = render(<TitleBar {...barProps} focus={focus} />);
      const tab = render(
        <TitleBar {...barProps} focus={focus} strip={MIDDLE_TAB} />,
      );

      for (const { container } of [own, tab]) {
        expect(face(container).className).toContain(
          css({ fontWeight: "normal" }),
        );
        expect(face(container).className).not.toContain(
          css({ fontWeight: "medium" }),
        );
      }
    }
  });

  it("raises the bar being worked in to the address bar, and sinks the rest below it", () => {
    // The focused bar matches the address bar, so it reads as part of its
    // window.
    const focused = render(<TitleBar {...barProps} focus="focused" />);
    expect(fill(focused.container, "raised").className).toContain(
      css({ backgroundColor: RAISED }),
    );
    expect(shows(fill(focused.container, "raised"))).toBe(true);

    const resting = render(<TitleBar {...barProps} />);
    expect(shows(fill(resting.container, "raised"))).toBe(false);
  });

  it("draws no bar's edge in the accent, whatever it says about the keyboard", () => {
    // The glow around the window marks focus instead. See `FocusGlow`.
    for (const focus of ["focused", "leaf", "resting", "selected"] as const) {
      const { container } = render(<TitleBar {...barProps} focus={focus} />);

      expect(face(container).className).toContain(
        css({ borderColor: "borderStrong" }),
      );
    }
  });

  // The window's surface reaches a row up under its bar, which hides that
  // row. An edge there would leave it showing, as the bar's layers fill only
  // inside its edges.
  it("covers the row of the window tucked under the bar", () => {
    const { className } = face(render(<TitleBar {...barProps} />).container);

    expect(className).toContain(css({ borderBlockEndWidth: 0 }));
    expect(className).toContain(css({ paddingBlockEnd: "1px" }));
  });

  it("washes the keyboard's own bar in the accent inside a selected group", () => {
    // The whole group is raised, so that alone would not mark this one.
    const { container } = render(<TitleBar {...barProps} focus="leaf" />);

    expect(fill(container, "leaf").className).toContain(
      css({
        backgroundColor:
          "color-mix(in oklab, {colors.accent} 45%, {colors.chrome})",
      }),
    );
    expect(shows(fill(container, "leaf"))).toBe(true);
    expect(
      shows(fill(render(<TitleBar {...barProps} />).container, "leaf")),
    ).toBe(false);
    expect(face(container).className).toContain(FAUX_MEDIUM);
  });

  describe("a tab", () => {
    const tab = (props: Partial<Parameters<typeof TitleBar>[0]>) =>
      render(
        <TitleBar
          {...barProps}
          strip={MIDDLE_TAB}
          tabbed={Layout.Tabbed}
          {...props}
        />,
      );
    afterEach(undrawPopups);

    // The strip draws the window's top edge along its bottom row. The open
    // tab covers it there to join its window; a stack's bars sit over each
    // other, not over the window.
    it("covers the strip's bottom edge only where it is the open tab", () => {
      const covers = css({ marginBlockEnd: "-1px" });

      expect(
        face(tab({ strip: { ...MIDDLE_TAB, open: true } }).container).className,
      ).toContain(covers);
      expect(face(tab({}).container).className).not.toContain(covers);
      expect(
        face(
          tab({
            strip: { ...MIDDLE_TAB, open: true },
            tabbed: Layout.Stacking,
          }).container,
        ).className,
      ).not.toContain(covers);
    });

    // The cover makes the open tab a row taller than a hidden one. Padding
    // that row keeps its title level, so a tab does not drop when opened.
    it("keeps the open tab's title level with a hidden tab's", () => {
      expect(
        face(tab({ strip: { ...MIDDLE_TAB, open: true } }).container).className,
      ).toContain(css({ paddingBlockEnd: "1px" }));
    });

    // A line box would add its strut under the button and lift it above the
    // tab's middle.
    it("centers its close button on the tab", () => {
      tab({});
      const holder = screen
        .getByRole("button", { name: "Close" })
        .closest("span");

      expect(holder).not.toBeNull();
      expect(holder?.className).toContain(css({ display: "flex" }));
    });

    // The buttons carry their own fill, over the title running under them.
    // Taller than the tab's inside, it painted over the open tab's top edge,
    // and at a fractional scale the strip's color showed round the buttons.
    it("keeps its buttons' fill clear of the open tab's edge", () => {
      const { container } = tab({ strip: { ...MIDDLE_TAB, open: true } });
      const buttonsFill = (layer: "hover" | "leaf" | "raised" | "rail") => {
        const element = face(container).querySelector<HTMLElement>(
          `:scope > span > [data-fill="${layer}"]`,
        );
        if (element === null) {
          throw new Error(`test: the buttons have no ${layer} layer`);
        } else {
          return element;
        }
      };

      expect(buttonsFill("rail").parentElement?.className).toContain(
        css({ alignSelf: "stretch" }),
      );
      expect(buttonsFill("hover").className).toContain(css({ inset: "1px" }));
      expect(buttonsFill("leaf").className).toContain(css({ inset: "1px" }));
      expect(buttonsFill("raised").className).toContain(css({ inset: "2px" }));
      expect(buttonsFill("rail").className).toContain(css({ inset: "3px" }));
    });

    it("edges the open tab stronger in a strip inside another group's well", () => {
      const strong = css({
        borderColor:
          "color-mix(in oklab, {colors.foreground} 40%, {colors.background})",
      });

      expect(
        fill(
          tab({ strip: { ...MIDDLE_TAB, nested: true, open: true } }).container,
          "raised",
        ).className,
      ).toContain(strong);
      expect(
        fill(tab({ strip: { ...MIDDLE_TAB, open: true } }).container, "raised")
          .className,
      ).not.toContain(strong);
    });

    it("draws the open tab on the address bar's surface", () => {
      const open = fill(
        tab({ strip: { ...MIDDLE_TAB, open: true } }).container,
        "raised",
      );

      expect(open.className).toContain(css({ backgroundColor: RAISED }));
      expect(open.className).toContain(css({ borderColor: "borderStrong" }));
      expect(shows(open)).toBe(true);
      expect(shows(fill(tab({}).container, "raised"))).toBe(false);
    });

    // A hidden tab broken out of its group grows into a bar, easing its
    // color as it goes. From a clear tab, the desktop shows through it.
    it("draws a hidden tab on the strip's own color", () => {
      const rail = fill(tab({}).container, "rail");

      expect(rail.className).toContain(css({ backgroundColor: "tabRail" }));
      expect(shows(rail)).toBe(true);
    });

    // Swapped tabs slide past each other. The open tab slides over its
    // neighbors, whose pieces of the strip would otherwise cover it.
    it("draws the open tab over the rest of its strip", () => {
      const depth = (strip: StripPlace) =>
        bar(tab({ depth: 2, strip }).container).style.zIndex;

      expect(depth({ ...MIDDLE_TAB, open: true })).toBe(raised(2).toString());
      expect(depth(MIDDLE_TAB)).toBe("2");
    });

    // A press on a hidden tab opens it; one on the open tab does nothing new.
    it("shows a pointer over a hidden tab but not the open one", () => {
      const cursor = (container: HTMLElement) =>
        globalThis.getComputedStyle(face(container)).cursor;

      expect(cursor(tab({}).container)).toBe("pointer");
      expect(
        cursor(tab({ strip: { ...MIDDLE_TAB, open: true } }).container),
      ).not.toBe("pointer");
    });

    it("marks off a hidden tab from the hidden tab before it", () => {
      expect(
        bar(tab({ strip: { ...MIDDLE_TAB, divided: true } }).container),
      ).toHaveAttribute("data-divided");
      expect(bar(tab({}).container)).not.toHaveAttribute("data-divided");
    });

    it("offers only to close while hidden, keeping room for its title", () => {
      const hidden = tab({});
      expect(hidden.queryByRole("button", { name: "Close" })).not.toBeNull();
      expect(hidden.queryByRole("button", { name: "Maximize" })).toBeNull();
      expect(hidden.queryByRole("button", { name: "Float" })).toBeNull();

      const open = tab({ strip: { ...MIDDLE_TAB, open: true } });
      expect(open.queryByRole("button", { name: "Maximize" })).not.toBeNull();
      expect(open.queryByRole("button", { name: "Float" })).not.toBeNull();
    });

    it("shows its whole title and its page's description while the pointer rests on it", async () => {
      const { getByText } = tab({
        description: "The Rust standard library",
        title: "std - Rust",
      });

      await userEvent.hover(getByText("std - Rust"));

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent("std - Rust");
      expect(tooltip).toHaveTextContent("The Rust standard library");
    });

    // Tabs sit outside their window's element, so their container's box is
    // all that keeps the tooltip off the windows beside it.
    it("keeps its tooltip inside its container", async () => {
      const container = { height: 830, width: 400, x: 0, y: 0 };
      const { container: drawn, getByText } = tab({
        rect: { height: 30, width: 40, x: 360, y: 0 },
        strip: { ...MIDDLE_TAB, area: container },
        title: "std - Rust",
      });
      drawAt(face(drawn), { height: 30, width: 40, x: 360, y: 0 });
      drawPopups("tooltip", { height: 40, width: 300 });

      await userEvent.hover(getByText("std - Rust"));

      await waitFor(() => {
        expect(popupLeft("tooltip") + 300).toBeLessThanOrEqual(400);
      });
    });

    it("shows only its whole title for a page with no description", async () => {
      const { getByText } = tab({ title: "std - Rust" });

      await userEvent.hover(getByText("std - Rust"));

      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        /^std - Rust$/,
      );
    });

    it("shows the layout and size of a group it stands for", () => {
      const { getByRole } = tab({
        group: { layout: Layout.SplitV, windows: ["a", "b", "c"] },
      });

      expect(getByRole("img", { name: "Column of 3" }).textContent).toBe("3");
    });

    it("builds in a group's new layout", () => {
      const group = { layout: Layout.SplitV, windows: ["a", "b", "c"] };
      const { getByRole, rerender } = tab({ group });
      rerender(
        <TitleBar
          {...barProps}
          group={{ ...group, layout: Layout.Stacking }}
          strip={MIDDLE_TAB}
          tabbed={Layout.Tabbed}
        />,
      );

      const mark = getByRole("img", { name: "Stack of 3" });
      expect(
        [...mark.querySelectorAll("[data-state=shown]")].map((part) =>
          part.getAttribute("data-part"),
        ),
      ).toEqual(["row", "row"]);
    });

    // Its icons move when their own button is pointed at, so the tab must
    // not be a control itself.
    it("is no control around its buttons", () => {
      const { container } = tab({
        group: { layout: Layout.SplitV, windows: ["a", "b", "c"] },
      });

      expect(face(container).closest("button, a, [role=button]")).toBeNull();
    });

    // A group's tab is named after its open window, so a window moved out of
    // it hands the tab to a new element.
    it("takes over from its group's tab before a window left the group", () => {
      const { played, settler } = recordedSettles();
      const groupTab = (
        open: string,
        windows: readonly string[],
        x: number,
      ) => (
        <SettleHandoffs>
          <TitleBar
            {...barProps}
            group={{ layout: Layout.SplitH, windows }}
            key={open}
            rect={{ ...ON_SCREEN, width: 240, x }}
            settler={settler}
            strip={MIDDLE_TAB}
            tabbed={Layout.Tabbed}
          />
        </SettleHandoffs>
      );
      const { rerender } = render(groupTab("c", ["b", "c"], 240));

      rerender(groupTab("b", ["b"], 480));

      expect(played).toStrictEqual([{ scaleX: 1, scaleY: 1, x: -240, y: 0 }]);
    });
  });

  // The bar spans its window, so its title has room; only tabs are cut.
  it("shows nothing while the pointer rests on a window's own bar", async () => {
    const { getByText } = render(
      <TitleBar {...barProps} description="A terminal" />,
    );

    await userEvent.hover(getByText("kitty"));
    // Longer than a tab takes to show its tooltip.
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_WAIT_MS));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("rounds its top corners, and squares them and drops its edge while its window fills the screen", () => {
    const rounded = globalThis.getComputedStyle(
      face(render(<TitleBar {...barProps} />).container),
    );
    const square = globalThis.getComputedStyle(
      face(render(<TitleBar {...barProps} fullscreen />).container),
    );

    expect(rounded.borderStartStartRadius).not.toBe("");
    expect(rounded.borderStartEndRadius).not.toBe("");
    expect(square.borderStartStartRadius).toBe("");
    expect(square.borderStartEndRadius).toBe("");
    expect(rounded.borderTopWidth).toBe("1px");
    expect(square.borderTopWidth).not.toBe("1px");
  });

  // A scratchpad window hangs from the screen's top edge.
  it("squares its top corners but keeps its edge while its window hangs", () => {
    const style = globalThis.getComputedStyle(
      face(render(<TitleBar {...barProps} hanging />).container),
    );

    expect(style.borderStartStartRadius).toBe("");
    expect(style.borderStartEndRadius).toBe("");
    expect(style.borderTopWidth).toBe("1px");
  });

  it("says when it is middle-clicked", async () => {
    await new Promise<void>((resolve) => {
      const { container } = render(
        <TitleBar
          {...barProps}
          onMiddleClick={() => {
            resolve();
          }}
        />,
      );
      fireEvent(
        bar(container),
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    });
  });

  // A press reaching the window frame selects the window, which would open a
  // hidden tab for an instant before the click closes it.
  it("keeps a middle press from the window around it", () => {
    const onReach = mock(() => undefined);
    const { container } = render(
      <div onPointerDown={onReach}>
        <TitleBar {...barProps} strip={MIDDLE_TAB} />
      </div>,
    );

    fireEvent.pointerDown(bar(container), { button: 1, pointerId: 1 });

    expect(onReach).not.toHaveBeenCalled();
  });

  describe("the button that fills the screen", () => {
    it("asks for the window it names to fill the screen", async () => {
      await new Promise<void>((resolve) => {
        const { getByRole } = render(
          <TitleBar
            {...barProps}
            onFullscreen={() => {
              resolve();
            }}
          />,
        );
        fireEvent.click(getByRole("button", { name: "Maximize" }));
      });
    });

    it("offers the screen back once its window has it", () => {
      // The bar stays over a fullscreen window, so its button restores it.
      const { queryByRole } = render(<TitleBar {...barProps} fullscreen />);

      expect(queryByRole("button", { name: "Maximize" })).toBeNull();
      expect(queryByRole("button", { name: "Restore" })).not.toBeNull();
    });

    it("turns its corners in, in the same drawing, once its window has the screen", () => {
      const { container, getByRole, rerender } = render(
        <TitleBar {...barProps} />,
      );
      const svg = getByRole("button", { name: "Maximize" }).querySelector(
        "svg",
      );
      rerender(<TitleBar {...barProps} fullscreen />);

      const restore = getByRole("button", { name: "Restore" });
      expect(restore.querySelector("svg")).toBe(svg);
      expect(container.querySelector("[data-part=corner-in]")).toHaveAttribute(
        "data-state",
        "shown",
      );
    });
  });

  describe("the button that floats the window", () => {
    it("asks for the window it names to float, left of the fullscreen button", async () => {
      await new Promise<void>((resolve) => {
        const { getByRole } = render(
          <TitleBar
            {...barProps}
            onFloat={() => {
              resolve();
            }}
          />,
        );
        const float = getByRole("button", { name: "Float" });
        expect(
          float.compareDocumentPosition(
            getByRole("button", { name: "Maximize" }),
          ),
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        fireEvent.click(float);
      });
    });

    it("offers to tile a floating window", () => {
      const { queryByRole } = render(<TitleBar {...barProps} floating />);

      expect(queryByRole("button", { name: "Float" })).toBeNull();
      expect(queryByRole("button", { name: "Tile" })).not.toBeNull();
    });

    it("gathers its windows into squares, in the same drawing, once its window floats", () => {
      const { container, getByRole, rerender } = render(
        <TitleBar {...barProps} />,
      );
      const svg = getByRole("button", { name: "Float" }).querySelector("svg");
      rerender(<TitleBar {...barProps} floating />);

      expect(getByRole("button", { name: "Tile" }).querySelector("svg")).toBe(
        svg,
      );
      expect(container.querySelector("[data-part=square]")).toHaveAttribute(
        "data-state",
        "shown",
      );
    });
  });
});
