import { describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { Direction } from "./direction";
import type { TabTarget } from "./tiled/aim";
import { Aim } from "./tiled/aim";
import { Layout } from "./tree/node";
import { useTabDrop } from "./useTabDrop";

/** Two tabs along the top of a strip. */
const tabAt = (id: string, at: number): TabTarget => ({
  at,
  depth: 0,
  node: { id, up: 0 },
  rect: { height: 30, width: 200, x: 200 * at, y: 0 },
  strip: { height: 30, width: 1000, x: 0, y: 0 },
  tabbed: Layout.Tabbed,
  windows: [id],
});
const TARGETS = {
  floats: [],
  screens: [],
  tabs: [tabAt("a", 0), tabAt("b", 1)],
  windows: [{ frame: { height: 400, width: 1000, x: 0, y: 0 }, id: "a" }],
};
const LINE = { height: 30, width: 4, x: 198, y: 0 };

/** A drag event carrying `data`, at `x`, `y`. */
const dragAt = (x: number, y: number, data: Record<string, string>) => {
  const event = {
    clientX: x,
    clientY: y,
    dataTransfer: {
      dropEffect: "none",
      getData: (type: string) => data[type] ?? "",
      types: Object.keys(data),
    },
    preventDefault: mock(() => undefined),
  };
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the fields read
  return event as any;
};

const render = () => {
  const calls = {
    onAim: mock((_aim: Aim | undefined) => undefined),
    onTabDrop: mock(
      (_target: unknown, _edge: Direction, _url: string) => undefined,
    ),
  };
  const { result } = renderHook(() =>
    useTabDrop({ targets: TARGETS, ...calls }),
  );
  return { calls, handlers: () => result.current };
};

describe("useTabDrop", () => {
  it("aims text held over a tab beside it, and takes the drop", () => {
    const { calls, handlers } = render();
    const over = dragAt(210, 10, { "text/plain": "hello" });
    act(() => {
      handlers().onDragOver(over);
    });
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(calls.onAim).toHaveBeenLastCalledWith(
      Aim.Tab({ id: "b", up: 0 }, Direction.Left, LINE, 0),
    );
  });

  it("opens the dropped link beside the tab aimed at", () => {
    const { calls, handlers } = render();
    const drop = dragAt(210, 10, {
      "text/plain": "x",
      "text/uri-list": "https://a.example/",
    });
    act(() => {
      handlers().onDrop(drop);
    });
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(calls.onTabDrop).toHaveBeenCalledWith(
      { id: "b", up: 0 },
      Direction.Left,
      "https://a.example/",
    );
    expect(calls.onAim).toHaveBeenLastCalledWith(undefined);
  });

  it("leaves a drag off every strip, or with nothing to open, to the page", () => {
    const { calls, handlers } = render();
    const off = dragAt(210, 200, { "text/plain": "hello" });
    const files = dragAt(210, 10, { Files: "" });
    act(() => {
      handlers().onDragOver(off);
      handlers().onDragOver(files);
    });
    expect(off.preventDefault).not.toHaveBeenCalled();
    expect(files.preventDefault).not.toHaveBeenCalled();
    expect(calls.onAim).toHaveBeenLastCalledWith(undefined);
  });

  it("hides the aim when the drag leaves the stage", () => {
    const { calls, handlers } = render();
    act(() => {
      handlers().onDragLeave({
        currentTarget: { contains: () => false },
        relatedTarget: null,
        // biome-ignore lint/suspicious/noExplicitAny: a stand-in
      } as any);
    });
    expect(calls.onAim).toHaveBeenLastCalledWith(undefined);
  });
});
