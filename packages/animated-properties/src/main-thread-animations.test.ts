import { describe, expect, it } from "bun:test";

import { mainThreadAnimations } from "./main-thread-animations";

/** The properties `source` animates off the compositor, by line. */
const found = (source: string) =>
  mainThreadAnimations(source).map(({ line, property }) => [line, property]);

describe(mainThreadAnimations, () => {
  describe("transitions", () => {
    it("passes compositor properties and repainted colors", () => {
      expect(
        found(`const a = css({
  transition: "opacity {durations.fast} {easings.out}, transform 1s, translate 1s, filter 1s, backdrop-filter 1s, clip-path 1s",
  transitionProperty: "color, background-color, border-color, outline-color, fill, stroke",
});`),
      ).toStrictEqual([]);
    });

    it("passes discrete steps and none", () => {
      expect(
        found(`const a = css({
  transition: "display {durations.slowest} allow-discrete",
  b: { transition: "none !important" },
});`),
      ).toStrictEqual([]);
    });

    it("finds a layout property, with its line", () => {
      expect(
        found(`const a = css({
  color: "red",
  transition: "opacity 1s, inline-size {durations.fast} {easings.out}",
});`),
      ).toStrictEqual([[3, "inline-size"]]);
    });

    it("reads every item of a multi-line template and a property list", () => {
      expect(
        found(`const a = css({
  transition: \`
    box-shadow 1s cubic-bezier(0.2, 0, 0, 1),
    opacity 1s
  \`,
  transitionProperty: "inset-block-start, translate, z-index",
});`),
      ).toStrictEqual([
        [2, "box-shadow"],
        [6, "inset-block-start"],
        [6, "z-index"],
      ]);
    });

    it("reads conditions and concatenations", () => {
      expect(
        found(`const a = css({
  transition: { _hover: "opacity 1s", base: "block-size 1s" },
  b: { transition: "opacity 1s, " + "height 1s" },
});`),
      ).toStrictEqual([
        [2, "block-size"],
        [3, "height"],
      ]);
    });

    it("finds a transition with no property, which is all of them", () => {
      expect(found(`const a = { transition: "0.15s" };`)).toStrictEqual([
        [1, "all"],
      ]);
    });

    it("finds custom properties, which animate on the main thread", () => {
      expect(found(`const a = { transition: "--glow 1s" };`)).toStrictEqual([
        [1, "--glow"],
      ]);
    });

    it("throws on a value it cannot read", () => {
      expect(() =>
        mainThreadAnimations(`const a = { transition: speed };`),
      ).toThrow("line 1");
    });
  });

  describe("keyframes", () => {
    it("finds what a frame sets off the compositor, by its line", () => {
      expect(
        found(`const k = {
  grow: {
    "0%": { opacity: "0", inlineSize: "0" },
    "50%, 75%": { transform: "none" },
    to: { boxShadow: "none", clipPath: "inset(0)" },
  },
};`),
      ).toStrictEqual([
        [3, "inline-size"],
        [5, "box-shadow"],
      ]);
    });

    it("finds frames outside any named keyframe", () => {
      expect(
        found(`const k = { from: { height: "0" }, to: { height: "1rem" } };`),
      ).toStrictEqual([
        [1, "height"],
        [1, "height"],
      ]);
    });

    it("takes an object as frames only if every key in it is a frame", () => {
      expect(
        found(
          `const drag = { from: { x: 1, y: 2 }, onDrop: () => undefined };`,
        ),
      ).toStrictEqual([]);
    });
  });

  describe("exemptions", () => {
    it("skips an entry under a comment giving a reason", () => {
      expect(
        found(`const a = css({
  // main-thread animation: a bar item opens to its width once.
  // More words.
  transition: "inline-size 1s",
  b: { transition: "block-size 1s" },
});`),
      ).toStrictEqual([[5, "block-size"]]);
    });

    it("skips a whole keyframe under a comment giving a reason", () => {
      expect(
        found(`const k = {
  // main-thread animation: draws a 16px icon's stroke.
  draw: {
    "0%": { strokeDashoffset: "1" },
    "100%": { strokeDashoffset: "0" },
  },
};`),
      ).toStrictEqual([]);
    });

    it("skips frames held in a constant under a comment giving a reason", () => {
      expect(
        found(`// main-thread animation: holds a fixed depth.
const HOLD = {
  "0%": { zIndex: "1" },
  "100%": { zIndex: "1" },
};`),
      ).toStrictEqual([]);
    });

    it("refuses a comment with no reason", () => {
      expect(() =>
        mainThreadAnimations(`const a = {
  // main-thread animation:
  transition: "height 1s",
};`),
      ).toThrow("reason");
    });
  });
});
