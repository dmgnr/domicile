import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";

import { css } from "../styled-system/css";
import type { MeasureChip } from "./Workspaces";
import { Workspaces } from "./Workspaces";

/**
 * Places each chip 30px after the last, 24px wide, and
 * records the chip it was last asked about.
 */
const fakeLayout = () => {
  const asked: { chip?: HTMLElement } = {};
  const measureChip: MeasureChip = (chip, onPlace) => {
    asked.chip = chip;
    const index = [...(chip.parentElement?.children ?? [])].indexOf(chip);
    onPlace({ start: index * 30, width: index === 3 ? 30 : 24 });
    return () => undefined;
  };
  return { asked, measureChip };
};

/**
 * The switcher with four workspaces and `current` on screen. Includes the
 * tenth to test that a two-digit label still fits.
 */
const switcher = ({ current = "2", focused = true } = {}) => {
  const { asked, measureChip } = fakeLayout();
  const props = {
    focused,
    measureChip,
    onSelect: () => undefined,
    workspaces: ["1", "2", "3", "10"],
  };
  const { rerender } = render(<Workspaces current={current} {...props} />);
  return {
    asked,
    highlight: () => screen.getByTestId("highlight"),
    switchTo: (name: string) => {
      rerender(<Workspaces current={name} {...props} />);
    },
    workspace: (name: string) => screen.getByRole("button", { name }),
  };
};

/** A hidden bold copy of the chip's number, which sets its width. */
const boldCopy = css({
  _after: {
    content: "attr(data-label)",
    fontWeight: "semibold",
    visibility: "hidden",
  },
});

describe("Workspaces", () => {
  describe("the highlight", () => {
    it("sits under the one on screen", () => {
      const { asked, highlight, workspace } = switcher();

      expect(asked.chip).toBe(workspace("2"));
      expect(highlight().style.getPropertyValue("--highlight-start")).toBe(
        "30px",
      );
      expect(highlight().style.getPropertyValue("--highlight-width")).toBe(
        "24px",
      );
    });

    it("moves to the next one on screen", () => {
      const { asked, highlight, switchTo, workspace } = switcher();

      switchTo("10");

      expect(asked.chip).toBe(workspace("10"));
      expect(highlight().style.getPropertyValue("--highlight-start")).toBe(
        "90px",
      );
      expect(highlight().style.getPropertyValue("--highlight-width")).toBe(
        "30px",
      );
    });

    it("is a white chip that shows only the numbers under it, in black", () => {
      // A copy of the row, clipped to the chip, so a number turns black as
      // the chip slides under it.
      const { highlight } = switcher();

      expect(highlight().getAttribute("aria-hidden")).toBe("true");
      expect(highlight().textContent).toBe("12310");
      expect(highlight().className).toContain(
        css({ backgroundColor: "onPhoto" }),
      );
      expect(highlight().className).toContain(css({ color: "black" }));
      expect(highlight().className).toContain(
        css({
          // From the start edge only, so it slides smoothly while a
          // workspace comes or goes at the row's end.
          clipPath:
            "xywh(calc(var(--highlight-start) + {spacing.10}) 0 var(--highlight-width) 100% round {radii.lg})",
        }),
      );
    });

    it("slides with a small bounce", () => {
      // The copy reaches past both ends of the row, so a bounce past the
      // first or last chip is not cut flat.
      const { highlight } = switcher();

      expect(highlight().className).toContain(css({ insetInline: -10 }));
      expect(highlight().className).toContain(css({ paddingInline: 10 }));

      expect(highlight().className).toContain(
        css({
          transition: `
            clip-path {durations.slower} {easings.outBack},
            opacity {durations.fast} {easings.out}
          `,
        }),
      );
    });

    // A layout read while React commits restyles and lays out the whole
    // desk at once, at the start of the workspace slide this switch begins.
    it("reads no layout while switching", () => {
      const props = {
        focused: true,
        onSelect: () => undefined,
        workspaces: ["1", "2"],
      };
      const { rerender } = render(<Workspaces current="1" {...props} />);
      const offsetLeft = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetLeft",
      );
      if (offsetLeft?.get === undefined) {
        throw new Error("test: HTMLElement has no offsetLeft getter");
      }
      const get = offsetLeft.get;
      const reads: string[] = [];
      Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
        ...offsetLeft,
        get(this: HTMLElement) {
          reads.push(this.tagName);
          return get.call(this);
        },
      });
      try {
        rerender(<Workspaces current="2" {...props} />);
      } finally {
        Object.defineProperty(HTMLElement.prototype, "offsetLeft", offsetLeft);
      }

      expect(reads).toEqual([]);
    });

    it("fades out on a screen the keyboard is not on", () => {
      const { highlight } = switcher({ focused: false });

      expect(highlight().getAttribute("data-shown")).toBe("false");
      expect(highlight().className).toContain(
        css({ "&[data-shown=false]": { opacity: 0 } }),
      );
    });
  });

  it("outlines the one on screen on a screen the keyboard is not on", () => {
    // One workspace has keyboard focus and it is on one screen: sway's
    // `focused_workspace` versus `active_workspace`.
    const { workspace } = switcher({ focused: false });

    expect(workspace("2").className).toContain(
      css({ boxShadow: "inset 0 0 0 0.09375rem {colors.onPhoto}" }),
    );
  });

  it("leaves the rest of them clear and only slightly dimmed", () => {
    const { workspace } = switcher();

    expect(workspace("1").className).toContain(
      css({ backgroundColor: "transparent" }),
    );
    expect(workspace("1").className).toContain(
      css({ color: "color-mix(in oklab, {colors.onPhoto} 85%, transparent)" }),
    );
  });

  it("keeps the chip white under the pointer", () => {
    // `_hoverEnabled` skips `aria-current`, so hovering the chip doesn't
    // draw the hover square over the highlight's edges.
    const { workspace } = switcher();

    expect(workspace("1").className).toContain(
      css({ _hoverEnabled: { backgroundColor: "fillOverPhoto" } }),
    );
    expect(workspace("1").className).not.toContain(
      css({ _hover: { backgroundColor: "fillOverPhoto" } }),
    );
  });

  it("centers the number rather than its baseline", () => {
    // Digits have no ascenders or descenders, so centering the line box leaves
    // them a few pixels high. Trimming the box to cap height and baseline
    // centers the glyph, and the trim only works on a block container.
    const { workspace } = switcher();

    for (const name of ["1", "2", "3", "10"]) {
      const [label] = workspace(name).children;
      expect(label?.className).toContain(
        css({ textBox: "trim-both cap alphabetic" }),
      );
    }
  });

  it("keeps every one as wide as its bold number", () => {
    // The highlight's copy is bold, so both rows reserve the bold width and
    // the copy lines up with the row whichever is on screen.
    const { highlight, workspace } = switcher();

    const copies = [...highlight().children];
    for (const [index, name] of ["1", "2", "3", "10"].entries()) {
      for (const chip of [workspace(name), copies[index]]) {
        expect(chip?.textContent).toBe(name);
        expect(chip?.getAttribute("data-label")).toBe(name);
        expect(chip?.className.split(" ")).toEqual(
          expect.arrayContaining(boldCopy.split(" ")),
        );
      }
    }
  });

  it("draws every one of them as a rounded square that two digits widen", () => {
    const { highlight, workspace } = switcher();

    for (const chip of [workspace("10"), ...highlight().children]) {
      expect(chip.className).toContain(css({ borderRadius: "lg" }));
      expect(chip.className).toContain(css({ blockSize: 6 }));
      expect(chip.className).toContain(css({ minInlineSize: 6 }));
    }
  });
});
