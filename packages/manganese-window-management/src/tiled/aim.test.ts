import { describe, expect, it } from "bun:test";

import { Direction } from "../direction";
import { Beside } from "../tree/drop";
import { Layout } from "../tree/node";
import type { Dragged, TabTarget } from "./aim";
import { Aim, aimAt, cornerOf, tabAimAt } from "./aim";

/** Window `id`'s node. */
const windowNode = (id: string) => ({ id, up: 0 });

/** The group window `id` is in. */
const groupOf = (id: string) => ({ id, up: 1 });

/** A drag of window `id` alone. */
const alone = (id: string): Dragged => ({
  node: windowNode(id),
  windows: [id],
});

/** The line between two tabs of `TABS`, at `x`. */
const lineAt = (x: number) => ({ height: 30, width: 4, x: x - 2, y: 0 });

const LEFT = { frame: { height: 400, width: 500, x: 0, y: 0 }, id: "a" };
const RIGHT = { frame: { height: 400, width: 500, x: 500, y: 0 }, id: "b" };
/** A screen below the two with nothing tiled on it. */
const EMPTY = { area: { height: 400, width: 1000, x: 0, y: 500 }, name: "low" };
const TARGETS = {
  floats: [],
  screens: [EMPTY],
  tabs: [],
  windows: [LEFT, RIGHT],
};

/** Three tabs along the top of a tabbed `ROW`, "a" open over all of it. */
const tabAt = (id: string, at: number): TabTarget => ({
  at,
  depth: 0,
  node: windowNode(id),
  rect: { height: 30, width: 200, x: 200 * at, y: 0 },
  strip: { height: 30, width: 1000, x: 0, y: 0 },
  tabbed: Layout.Tabbed,
  windows: [id],
});
const ROW = { frame: { height: 400, width: 1000, x: 0, y: 0 }, id: "a" };
const TABS = {
  floats: [],
  screens: [],
  tabs: [tabAt("a", 0), tabAt("b", 1), tabAt("c", 2)],
  windows: [ROW],
};

describe("aimAt", () => {
  describe("with a floating group over the windows", () => {
    /** A float over "a" and "b", its strip's one tab "f" at its top. */
    const FLOAT = {
      depth: 2,
      frame: { height: 300, width: 400, x: 300, y: 100 },
      windows: ["f"],
    };
    const floatTab = (id: string, at: number, depth: number): TabTarget => ({
      at,
      depth,
      node: windowNode(id),
      rect: { height: 30, width: 200, x: 300 + 200 * at, y: 100 },
      strip: { height: 30, width: 400, x: 300, y: 100 },
      tabbed: Layout.Tabbed,
      windows: [id],
    });
    const FLOATING = {
      ...TARGETS,
      floats: [FLOAT],
      tabs: [floatTab("f", 0, 2)],
    };

    it("aims at its tabs", () => {
      expect(aimAt(FLOATING, alone("a"), 350, 110)).toEqual(
        Aim.Tab(
          windowNode("f"),
          Direction.Left,
          { height: 30, width: 4, x: 298, y: 100 },
          2,
        ),
      );
    });

    it("aims at nothing under it", () => {
      expect(aimAt(FLOATING, alone("a"), 600, 300)).toBeUndefined();
    });

    // A lone float moves under the pointer as it is dragged.
    it("hides nothing from a drag that carries it", () => {
      expect(aimAt(FLOATING, alone("f"), 600, 300)).toMatchObject({
        node: { id: "b", up: 0 },
      });
    });

    it("aims at the front one of two strips", () => {
      const front = {
        ...FLOAT,
        depth: 4,
        frame: { ...FLOAT.frame, x: 350 },
        windows: ["g"],
      };
      expect(
        aimAt(
          {
            ...FLOATING,
            floats: [FLOAT, front],
            tabs: [
              floatTab("f", 0, 2),
              {
                ...floatTab("g", 0, 4),
                rect: { height: 30, width: 200, x: 350, y: 100 },
              },
            ],
          },
          alone("a"),
          380,
          110,
        ),
      ).toMatchObject({ node: { id: "g" } });
    });

    it("aims at nothing for a tab behind another float", () => {
      const front = {
        depth: 4,
        frame: { height: 300, width: 400, x: 200, y: 50 },
        windows: ["g"],
      };
      expect(
        aimAt({ ...FLOATING, floats: [FLOAT, front] }, alone("a"), 350, 110),
      ).toBeUndefined();
    });
  });

  it("aims at the middle of the window under the pointer", () => {
    expect(aimAt(TARGETS, alone("a"), 750, 200)).toEqual(
      Aim.Window("b", undefined, RIGHT.frame),
    );
  });

  it("aims at the edge of it the pointer is near, and half of it", () => {
    expect(aimAt(TARGETS, alone("a"), 520, 200)).toEqual(
      Aim.Window("b", Direction.Left, {
        height: 400,
        width: 250,
        x: 500,
        y: 0,
      }),
    );
    expect(aimAt(TARGETS, alone("a"), 750, 390)).toEqual(
      Aim.Window("b", Direction.Down, {
        height: 200,
        width: 500,
        x: 500,
        y: 200,
      }),
    );
  });

  it("aims at nothing over the window being dragged", () => {
    expect(aimAt(TARGETS, alone("a"), 250, 200)).toBeUndefined();
  });

  it("aims at all of a screen with nothing tiled on it", () => {
    expect(aimAt(TARGETS, alone("a"), 250, 600)).toEqual(
      Aim.Screen("low", EMPTY.area),
    );
  });

  it("aims at nothing where there is no window", () => {
    expect(aimAt(TARGETS, alone("a"), 250, 450)).toBeUndefined();
  });

  it("aims a window before or after the tab under the pointer, by its half", () => {
    // Over the open window's frame too: the tab wins.
    expect(aimAt(TABS, alone("x"), 550, 10)).toEqual(
      Aim.Tab(windowNode("c"), Direction.Right, lineAt(600), 0),
    );
    expect(aimAt(TABS, alone("x"), 250, 10)).toEqual(
      Aim.Tab(windowNode("b"), Direction.Left, lineAt(200), 0),
    );
  });

  it("aims a window beside the nearest tab anywhere on the strip", () => {
    // Past the last tab, over the strip's empty end.
    expect(aimAt(TABS, alone("x"), 800, 10)).toEqual(
      Aim.Tab(windowNode("c"), Direction.Right, lineAt(600), 0),
    );
  });

  it("moves a tab along its own strip from anywhere on it", () => {
    expect(aimAt(TABS, alone("a"), 800, 10)).toEqual(
      Aim.Strip(windowNode("c"), Direction.Right, tabAt("c", 2).rect),
    );
  });

  it("moves a tab along its own strip into the slot under the pointer", () => {
    // Either half of the slot: the tabs are the same size, so the moved tab
    // lands under the pointer.
    expect(aimAt(TABS, alone("a"), 250, 10)).toEqual(
      Aim.Strip(windowNode("b"), Direction.Right, tabAt("b", 1).rect),
    );
    expect(aimAt(TABS, alone("c"), 210, 10)).toEqual(
      Aim.Strip(windowNode("b"), Direction.Left, tabAt("b", 1).rect),
    );
  });

  it("moves a stacked tab up or down its strip", () => {
    const stackedAt = (id: string, at: number): TabTarget => ({
      at,
      depth: 0,
      node: windowNode(id),
      rect: { height: 30, width: 1000, x: 0, y: 30 * at },
      strip: { height: 60, width: 1000, x: 0, y: 0 },
      tabbed: Layout.Stacking,
      windows: [id],
    });
    const targets = {
      floats: [],
      screens: [],
      tabs: [stackedAt("a", 0), stackedAt("b", 1)],
      windows: [],
    };
    expect(aimAt(targets, alone("a"), 500, 40)).toEqual(
      Aim.Strip(windowNode("b"), Direction.Down, stackedAt("b", 1).rect),
    );
    expect(aimAt(targets, alone("b"), 500, 20)).toEqual(
      Aim.Strip(windowNode("a"), Direction.Up, stackedAt("a", 0).rect),
    );
  });

  it("aims a tab above or below a stacked one, by its half", () => {
    const stacked: TabTarget = {
      at: 1,
      depth: 0,
      node: windowNode("b"),
      rect: { height: 30, width: 1000, x: 0, y: 30 },
      strip: { height: 60, width: 1000, x: 0, y: 0 },
      tabbed: Layout.Stacking,
      windows: ["b"],
    };
    const targets = { floats: [], screens: [], tabs: [stacked], windows: [] };
    expect(aimAt(targets, alone("a"), 500, 50)).toEqual(
      Aim.Tab(
        windowNode("b"),
        Direction.Down,
        { height: 4, width: 1000, x: 0, y: 58 },
        0,
      ),
    );
  });

  it("aims at nothing over the dragged window's own tab", () => {
    expect(aimAt(TABS, alone("b"), 250, 10)).toBeUndefined();
  });

  it("aims beside the tab group of the window under the pointer, at its edge", () => {
    expect(aimAt(TABS, alone("x"), 990, 200)).toEqual(
      Aim.Group(groupOf("a"), Direction.Right, {
        height: 400,
        width: 500,
        x: 500,
        y: 0,
      }),
    );
  });

  it("aims beside a tab group of one at its edge, not into its strip", () => {
    const lone = { ...TABS, tabs: [tabAt("a", 0)] };

    expect(aimAt(lone, alone("x"), 990, 200)).toEqual(
      Aim.Group(groupOf("a"), Direction.Right, {
        height: 400,
        width: 500,
        x: 500,
        y: 0,
      }),
    );
  });

  it("aims a tab over its own group at the half of the group it is in", () => {
    // Beside the group, through one of its other tabs, since this one leaves.
    expect(aimAt(TABS, alone("a"), 900, 200)).toEqual(
      Aim.Group(groupOf("b"), Direction.Right, {
        height: 400,
        width: 500,
        x: 500,
        y: 0,
      }),
    );
    expect(aimAt(TABS, alone("a"), 500, 210)).toEqual(
      Aim.Group(groupOf("b"), Direction.Down, {
        height: 200,
        width: 1000,
        x: 0,
        y: 200,
      }),
    );
  });

  it("aims apart from a group, and along a strip", () => {
    expect(aimAt(TABS, alone("a"), 900, 200)).toMatchObject({
      beside: Beside.Apart,
    });
    expect(aimAt(TABS, alone("a"), 450, 10)).toMatchObject({
      beside: Beside.InStrip,
    });
    expect(aimAt(TARGETS, alone("x"), 980, 200)).toMatchObject({
      beside: Beside.InStrip,
    });
  });

  describe("with a nested group's tab on the strip", () => {
    /** "b"'s tab stands for a group of "b" and "d". */
    const GROUP_TAB: TabTarget = {
      ...tabAt("b", 1),
      node: groupOf("b"),
      windows: ["b", "d"],
    };
    const NESTED = { ...TABS, tabs: [tabAt("a", 0), GROUP_TAB, tabAt("c", 2)] };

    it("moves a tab along the strip past it", () => {
      expect(aimAt(NESTED, alone("a"), 250, 10)).toEqual(
        Aim.Strip(groupOf("b"), Direction.Right, GROUP_TAB.rect),
      );
    });

    it("moves it along the strip", () => {
      const group = { node: groupOf("b"), windows: ["b", "d"] };
      expect(aimAt(NESTED, group, 450, 10)).toEqual(
        Aim.Strip(windowNode("c"), Direction.Right, tabAt("c", 2).rect),
      );
    });

    it("aims a window inside it beside it, by its half", () => {
      expect(aimAt(NESTED, alone("d"), 250, 10)).toEqual(
        Aim.Tab(groupOf("b"), Direction.Left, lineAt(200), 0),
      );
      expect(aimAt(NESTED, alone("d"), 350, 10)).toEqual(
        Aim.Tab(groupOf("b"), Direction.Right, lineAt(400), 0),
      );
    });

    it("aims a window inside it past it from the strip's end", () => {
      const last = { ...TABS, tabs: [tabAt("a", 0), GROUP_TAB] };
      expect(aimAt(last, alone("d"), 900, 10)).toEqual(
        Aim.Tab(groupOf("b"), Direction.Right, lineAt(400), 0),
      );
    });

    it("aims a group's only window beside the group, by its half", () => {
      // The group is the first tab, then the last: past it is the only way
      // out of the strip on that side.
      const lone = {
        ...GROUP_TAB,
        at: 0,
        rect: tabAt("a", 0).rect,
        windows: ["b"],
      };
      const first = { ...TABS, tabs: [lone, tabAt("a", 1)] };
      expect(aimAt(first, alone("b"), 50, 10)).toEqual(
        Aim.Tab(groupOf("b"), Direction.Left, lineAt(0), 0),
      );
      const last = { ...GROUP_TAB, windows: ["b"] };
      expect(
        aimAt({ ...TABS, tabs: [tabAt("a", 0), last] }, alone("b"), 350, 10),
      ).toEqual(Aim.Tab(groupOf("b"), Direction.Right, lineAt(400), 0));
    });

    it("aims a tab over its own group beside the group around it", () => {
      expect(aimAt(NESTED, alone("a"), 990, 200)).toEqual(
        Aim.Group({ id: "b", up: 2 }, Direction.Right, {
          height: 400,
          width: 500,
          x: 500,
          y: 0,
        }),
      );
    });
  });

  it("aims a dragged group at nothing inside it, and beside the rest", () => {
    // The group is the strip of "a", "b" and "c": its tabs and the window
    // they open over.
    expect(
      aimAt(
        TABS,
        { node: { id: "a", up: 1 }, windows: ["a", "b", "c"] },
        250,
        10,
      ),
    ).toBeUndefined();
    expect(
      aimAt(
        TABS,
        { node: { id: "a", up: 1 }, windows: ["a", "b", "c"] },
        500,
        200,
      ),
    ).toBeUndefined();
    expect(
      aimAt(
        TARGETS,
        { node: { id: "a", up: 1 }, windows: ["a", "x"] },
        750,
        200,
      ),
    ).toEqual(Aim.Window("b", undefined, RIGHT.frame));
  });
});

describe("cornerOf", () => {
  it("is the corner of the quarter the pointer took hold of", () => {
    expect(cornerOf(LEFT.frame, 100, 300)).toEqual({
      horizontal: Direction.Left,
      vertical: Direction.Down,
    });
    expect(cornerOf(LEFT.frame, 400, 100)).toEqual({
      horizontal: Direction.Right,
      vertical: Direction.Up,
    });
  });
});

// A lone float moves as it is dragged, and joins a group only over its tabs.
describe("tabAimAt", () => {
  it("aims beside the tab under the pointer", () => {
    expect(tabAimAt(TABS, alone("f"), 250, 10)).toEqual(
      aimAt(TABS, alone("f"), 250, 10),
    );
  });

  it("aims at nothing over a window or a screen", () => {
    expect(tabAimAt(TABS, alone("f"), 250, 200)).toBeUndefined();
    expect(tabAimAt(TARGETS, alone("f"), 250, 600)).toBeUndefined();
  });
});
