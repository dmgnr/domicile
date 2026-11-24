import { describe, expect, it } from "bun:test";

import { Direction } from "../direction";
import { arrivedOn, Beside, droppedOn } from "./drop";
import { Layout, LayoutNode } from "./node";
import {
  focusedIdOf,
  focusedNodeOf,
  focusedParent,
  withFocusOn,
} from "./tiling";

const ROW = {
  depth: 1,
  root: LayoutNode.Container(
    Layout.SplitH,
    [LayoutNode.Window("a"), LayoutNode.Window("b"), LayoutNode.Window("c")],
    0,
    [0.2, 0.3, 0.5],
  ),
};

describe("droppedOn", () => {
  it("joins the window dropped on the middle of in a tab group", () => {
    const dropped = droppedOn(
      ROW,
      { id: "a", up: 0 },
      { id: "c", up: 0 },
      undefined,
    );

    expect(dropped.root).toMatchObject({
      children: [
        { id: "b" },
        {
          children: [{ id: "c" }, { id: "a" }],
          focused: 1,
          layout: Layout.Tabbed,
        },
      ],
      layout: Layout.SplitH,
    });
    expect(focusedIdOf(dropped)).toBe("a");
  });

  it("goes beside a window dropped on the edge that runs along its row", () => {
    const dropped = droppedOn(
      ROW,
      { id: "a", up: 0 },
      { id: "c", up: 0 },
      Direction.Left,
    );

    expect(dropped.root).toMatchObject({
      children: [{ id: "b" }, { id: "a" }, { id: "c" }],
      layout: Layout.SplitH,
    });
    expect(focusedIdOf(dropped)).toBe("a");
  });

  it("splits a window dropped on the edge across its row", () => {
    const dropped = droppedOn(
      ROW,
      { id: "a", up: 0 },
      { id: "c", up: 0 },
      Direction.Up,
    );

    expect(dropped.root).toMatchObject({
      children: [
        LayoutNode.Window("b"),
        {
          children: [LayoutNode.Window("a", 1), LayoutNode.Window("c")],
          layout: Layout.SplitV,
        },
      ],
    });
    expect(focusedIdOf(dropped)).toBe("a");
  });

  it("splits the workspace when the window dropped on is all that is left", () => {
    const pair = {
      depth: 1,
      root: LayoutNode.Container(Layout.SplitH, [
        LayoutNode.Window("a"),
        LayoutNode.Window("b"),
      ]),
    };

    expect(
      droppedOn(pair, { id: "a", up: 0 }, { id: "b", up: 0 }, Direction.Down)
        .root,
    ).toMatchObject({
      children: [{ id: "b" }, { id: "a" }],
      layout: Layout.SplitV,
    });
  });

  it("leaves the tree alone when a window is dropped on itself", () => {
    const tiling = withFocusOn(ROW, "b");

    expect(
      droppedOn(tiling, { id: "b", up: 0 }, { id: "b", up: 0 }, Direction.Left),
    ).toBe(tiling);
  });

  describe("a tab group", () => {
    const TABS = {
      depth: 1,
      root: LayoutNode.Container(Layout.Tabbed, [
        LayoutNode.Window("a"),
        LayoutNode.Window("b"),
        LayoutNode.Window("c"),
      ]),
    };

    it("takes a window dropped beside one of its tabs into its strip", () => {
      expect(
        droppedOn(TABS, { id: "c", up: 0 }, { id: "a", up: 0 }, Direction.Right)
          .root,
      ).toMatchObject({
        children: [{ id: "a" }, { id: "c" }, { id: "b" }],
        layout: Layout.Tabbed,
      });
    });

    it("takes a window dropped on the middle of a tab in after it", () => {
      expect(
        droppedOn(TABS, { id: "c", up: 0 }, { id: "a", up: 0 }, undefined).root,
      ).toMatchObject({
        children: [{ id: "a" }, { id: "c" }, { id: "b" }],
        layout: Layout.Tabbed,
      });
    });

    it("takes a window dropped beside a nested group of one into its strip", () => {
      const nested = {
        depth: 1,
        root: LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("a"),
          LayoutNode.Container(Layout.Tabbed, [LayoutNode.Window("b")]),
          LayoutNode.Window("c"),
        ]),
      };

      expect(
        droppedOn(
          nested,
          { id: "a", up: 0 },
          { id: "b", up: 1 },
          Direction.Right,
        ).root,
      ).toMatchObject({
        children: [
          { children: [{ id: "b" }], layout: Layout.Tabbed },
          { id: "a" },
          { id: "c" },
        ],
        layout: Layout.Tabbed,
      });
    });

    it("moves a tab past a nested group in a strip of two, keeping the group", () => {
      const pair = {
        depth: 1,
        root: LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("a"),
          LayoutNode.Container(Layout.Tabbed, [
            LayoutNode.Window("b"),
            LayoutNode.Window("c"),
          ]),
        ]),
      };

      expect(
        droppedOn(pair, { id: "a", up: 0 }, { id: "b", up: 1 }, Direction.Right)
          .root,
      ).toMatchObject({
        children: [
          { children: [{ id: "b" }, { id: "c" }], layout: Layout.Tabbed },
          { id: "a" },
        ],
        layout: Layout.Tabbed,
      });
    });

    it("takes a nested group's window dropped beside the group out of it", () => {
      const pair = {
        depth: 1,
        root: LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("a"),
          LayoutNode.Container(
            Layout.Tabbed,
            [LayoutNode.Window("b"), LayoutNode.Window("c")],
            1,
          ),
        ]),
      };

      // The group's tab names it by "c", the window leaving it.
      expect(
        droppedOn(pair, { id: "c", up: 0 }, { id: "c", up: 1 }, Direction.Right)
          .root,
      ).toMatchObject({
        children: [
          { id: "a" },
          { children: [{ id: "b" }], layout: Layout.Tabbed },
          { id: "c" },
        ],
        layout: Layout.Tabbed,
      });
    });

    it("takes a nested group's only window out past it at either end", () => {
      /** A strip of "b" alone in a nested group, then "a"; "b" last. */
      const strip = (nestedFirst: boolean) => {
        const nested = LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("b"),
        ]);
        const other = LayoutNode.Window("a");
        return {
          depth: 2,
          root: LayoutNode.Container(
            Layout.Tabbed,
            nestedFirst ? [nested, other] : [other, nested],
            nestedFirst ? 0 : 1,
          ),
        };
      };
      const group = { id: "b", up: 1 };
      const window = { id: "b", up: 0 };

      expect(
        droppedOn(strip(true), window, group, Direction.Left).root,
      ).toMatchObject({
        children: [{ id: "b" }, { id: "a" }],
        layout: Layout.Tabbed,
      });
      expect(
        droppedOn(strip(false), window, group, Direction.Right).root,
      ).toMatchObject({
        children: [{ id: "a" }, { id: "b" }],
        layout: Layout.Tabbed,
      });
    });

    it("splits a nested group with a window dropped apart from it", () => {
      const pair = {
        depth: 1,
        root: LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("a"),
          LayoutNode.Container(Layout.Tabbed, [
            LayoutNode.Window("b"),
            LayoutNode.Window("c"),
          ]),
        ]),
      };

      expect(
        droppedOn(
          pair,
          { id: "c", up: 0 },
          { id: "b", up: 1 },
          Direction.Right,
          Beside.Apart,
        ).root,
      ).toMatchObject({
        children: [
          { id: "a" },
          {
            children: [
              { children: [{ id: "b" }], layout: Layout.Tabbed },
              { id: "c" },
            ],
            layout: Layout.SplitH,
          },
        ],
        layout: Layout.Tabbed,
      });
    });

    it("splits a nested group with a tab of its strip dropped apart from it", () => {
      const groups = {
        depth: 1,
        root: LayoutNode.Container(Layout.Tabbed, [
          LayoutNode.Window("a"),
          LayoutNode.Container(Layout.Tabbed, [LayoutNode.Window("b")]),
          LayoutNode.Container(Layout.Tabbed, [LayoutNode.Window("c")]),
        ]),
      };

      expect(
        droppedOn(
          groups,
          { id: "b", up: 1 },
          { id: "c", up: 1 },
          Direction.Right,
          Beside.Apart,
        ).root,
      ).toMatchObject({
        children: [
          { id: "a" },
          {
            children: [
              { children: [{ id: "c" }] },
              { children: [{ id: "b" }] },
            ],
            layout: Layout.SplitH,
          },
        ],
        layout: Layout.Tabbed,
      });
    });

    it("splits with a window dropped on its edge, which leaves it", () => {
      expect(
        droppedOn(TABS, { id: "c", up: 0 }, { id: "a", up: 1 }, Direction.Right)
          .root,
      ).toMatchObject({
        children: [
          {
            children: [{ id: "a" }, { id: "b" }],
            layout: Layout.Tabbed,
          },
          { id: "c" },
        ],
        layout: Layout.SplitH,
      });
    });
  });

  it("splits a tab group of one with a window dropped on any of its edges", () => {
    const lone = {
      depth: 1,
      root: LayoutNode.Container(Layout.SplitV, [
        LayoutNode.Container(Layout.Tabbed, [LayoutNode.Window("a")]),
        LayoutNode.Window("b"),
      ]),
    };

    expect(
      droppedOn(lone, { id: "b", up: 0 }, { id: "a", up: 1 }, Direction.Right)
        .root,
    ).toMatchObject({
      children: [{ id: "a" }, { id: "b" }],
      layout: Layout.SplitH,
    });
  });

  describe("a group", () => {
    /** A tab group of "a" and "b" beside "c", focus on "a". */
    const TABS_BESIDE = withFocusOn(
      {
        depth: 0,
        root: LayoutNode.Container(Layout.SplitH, [
          LayoutNode.Container(Layout.Tabbed, [
            LayoutNode.Window("a"),
            LayoutNode.Window("b"),
          ]),
          LayoutNode.Window("c"),
        ]),
      },
      "a",
    );
    const GROUP = { id: "a", up: 1 };

    it("goes beside a window dropped on its edge", () => {
      const dropped = droppedOn(
        TABS_BESIDE,
        GROUP,
        { id: "c", up: 0 },
        Direction.Right,
      );

      expect(dropped.root).toMatchObject({
        children: [
          { id: "c" },
          {
            children: [{ id: "a" }, { id: "b" }],
            layout: Layout.Tabbed,
          },
        ],
        layout: Layout.SplitH,
      });
    });

    it("focuses its window alone when it was not selected", () => {
      const dropped = droppedOn(
        TABS_BESIDE,
        GROUP,
        { id: "c", up: 0 },
        Direction.Right,
      );

      expect(focusedNodeOf(dropped)).toMatchObject({ id: "a" });
    });

    it("stays selected when it was selected", () => {
      const dropped = droppedOn(
        focusedParent(TABS_BESIDE),
        GROUP,
        { id: "c", up: 0 },
        Direction.Right,
      );

      expect(focusedNodeOf(dropped)).toMatchObject({ layout: Layout.Tabbed });
    });

    it("goes in as a tab of a window dropped on the middle of", () => {
      expect(
        droppedOn(TABS_BESIDE, GROUP, { id: "c", up: 0 }, undefined).root,
      ).toMatchObject({
        children: [{ id: "c" }, { layout: Layout.Tabbed }],
        layout: Layout.Tabbed,
      });
    });

    it("leaves the tree alone when dropped on a window inside it", () => {
      expect(
        droppedOn(TABS_BESIDE, GROUP, { id: "b", up: 0 }, Direction.Left),
      ).toBe(TABS_BESIDE);
    });
  });
});

describe("arrivedOn", () => {
  it("splits a nested group with a window dropped apart from it", () => {
    const nested = {
      depth: 1,
      root: LayoutNode.Container(Layout.Tabbed, [
        LayoutNode.Window("a"),
        LayoutNode.Container(Layout.Tabbed, [LayoutNode.Window("b")]),
      ]),
    };

    expect(
      arrivedOn(
        nested,
        LayoutNode.Window("c"),
        false,
        { id: "b", up: 1 },
        Direction.Left,
        Beside.Apart,
      ).root,
    ).toMatchObject({
      children: [
        { id: "a" },
        {
          children: [{ id: "c" }, { children: [{ id: "b" }] }],
          layout: Layout.SplitH,
        },
      ],
      layout: Layout.Tabbed,
    });
  });
});
