import { beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { ORDER_KEY, rememberKeys } from "./remembered-keys";
import { useTrayOrder } from "./useTrayOrder";

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("useTrayOrder", () => {
  it("starts from the order last remembered", () => {
    rememberKeys(ORDER_KEY, ["b", "a"]);

    const { result } = renderHook(() => useTrayOrder([]));

    expect(result.current.order).toStrictEqual(["b", "a"]);
  });

  it("moves an item, and remembers the move", () => {
    const { result } = renderHook(() => useTrayOrder([]));

    act(() => {
      result.current.move(["a", "b"], "b", "a");
    });

    expect(result.current.order).toStrictEqual(["b", "a"]);
    expect(
      renderHook(() => useTrayOrder([])).result.current.order,
    ).toStrictEqual(["b", "a"]);
  });

  it("places an icon where it first arrived, so it comes back there", () => {
    // Otherwise `b`, closed and reopened, would come after `c`.
    const { rerender, result } = renderHook(
      ({ shown }) => useTrayOrder(shown),
      { initialProps: { shown: ["a", "b"] } },
    );
    rerender({ shown: ["a", "c"] });
    rerender({ shown: ["a", "c", "b"] });

    expect(result.current.order).toStrictEqual(["a", "b", "c"]);
    expect(
      renderHook(() => useTrayOrder([])).result.current.order,
    ).toStrictEqual(["a", "b", "c"]);
  });

  it("follows a move made on another page of the desk", () => {
    // Each monitor can have its own page; a `storage` event tells the others of
    // a drag.
    const { result } = renderHook(() => useTrayOrder([]));

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: ORDER_KEY,
          newValue: JSON.stringify(["c", "a"]),
        }),
      );
    });

    expect(result.current.order).toStrictEqual(["c", "a"]);
  });

  it("ignores what another page writes under another key", () => {
    rememberKeys(ORDER_KEY, ["a"]);
    const { result } = renderHook(() => useTrayOrder([]));

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", { key: "theme:v2", newValue: "light" }),
      );
    });

    expect(result.current.order).toStrictEqual(["a"]);
  });
});
