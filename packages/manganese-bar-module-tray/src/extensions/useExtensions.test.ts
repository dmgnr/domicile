import { describe, expect, it } from "bun:test";
import type { Extension } from "@domicile-desktop/sdk/extension";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook } from "@testing-library/react";

import { useExtensions } from "./useExtensions";

/** A fake host whose extensions a test sets. A popup-less action has `null`. */
const client = () => {
  const fake = new FakeDomicileHost();
  return {
    domicile: fake.domicile,
    says: (extensions: readonly Extension[]) => {
      act(() => {
        fake.set({
          extensions: extensions.map((said) => ({
            ...said,
            popup: said.popup ?? null,
            profile: "default",
          })),
        });
      });
    },
  };
};

const extension = (id: string): Extension => ({
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id,
  name: id,
  popup: undefined,
  profile: "default",
  title: id,
});

const FIRST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("useExtensions", () => {
  it("has none until the engine has said", () => {
    const host = client();

    const { result } = renderHook(() => useExtensions(host.domicile));

    expect(result.current).toEqual([]);
  });

  it("is the list last said, whole", () => {
    // Each message carries the full list, so a removed extension is simply
    // absent.
    const host = client();
    const { result } = renderHook(() => useExtensions(host.domicile));

    host.says([extension(FIRST), extension(SECOND)]);
    host.says([extension(SECOND)]);

    expect(result.current).toEqual([extension(SECOND)]);
  });
});
