import { beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { rememberedKeys, rememberKeys, UNPINNED_KEY } from "./remembered-keys";
import { useTrayPins } from "./useTrayPins";

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("useTrayPins", () => {
  it("pins every icon on a machine that has unpinned none", () => {
    const { result } = renderHook(() => useTrayPins());

    expect(result.current.unpinned).toStrictEqual(new Set());
  });

  it("starts from the icons last unpinned", () => {
    rememberKeys(UNPINNED_KEY, ["a"]);

    const { result } = renderHook(() => useTrayPins());

    expect(result.current.unpinned).toStrictEqual(new Set(["a"]));
  });

  it("unpins and pins an icon, and remembers it", () => {
    const { result } = renderHook(() => useTrayPins());

    act(() => {
      result.current.unpin("a");
    });
    act(() => {
      result.current.unpin("b");
    });
    expect(result.current.unpinned).toStrictEqual(new Set(["a", "b"]));
    act(() => {
      result.current.pin("a");
    });

    expect(result.current.unpinned).toStrictEqual(new Set(["b"]));
    expect(rememberedKeys(UNPINNED_KEY)).toStrictEqual(["b"]);
  });

  it("follows a pin changed on another page of the desk", () => {
    const { result } = renderHook(() => useTrayPins());

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: UNPINNED_KEY,
          newValue: JSON.stringify(["c"]),
        }),
      );
    });

    expect(result.current.unpinned).toStrictEqual(new Set(["c"]));
  });
});
