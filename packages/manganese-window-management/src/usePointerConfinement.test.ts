import { describe, expect, it } from "bun:test";
import type { Box, ClientWindow } from "@domicile-desktop/sdk/desktop/windows";
import { listedWindow } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook } from "@testing-library/react";

import type { Rect } from "./rect";
import type { ConfiningDesktop } from "./usePointerConfinement";
import { usePointerConfinement } from "./usePointerConfinement";

/** A desktop the test changes, recording what the shell asks of it. */
const fakeDesktop = (list: ClientWindow[], focused: string | undefined) => {
  const listeners = new Set<() => void>();
  const confined: (readonly Box[])[] = [];
  const told: [string, boolean][] = [];
  const state = { focused, list };
  const desktop: ConfiningDesktop = {
    pointer: {
      confine: (boxes) => {
        confined.push(boxes);
        return Promise.resolve(true);
      },
    },
    windows: {
      get focused() {
        return state.focused;
      },
      get list() {
        return state.list;
      },
      on: (_type, listener) => {
        const call = () => {
          (listener as () => void)();
        };
        listeners.add(call);
        return () => listeners.delete(call);
      },
      pointerConstrained: (appId, active) => {
        told.push([appId, active]);
      },
    },
  };
  const change = (next: Partial<typeof state>) => {
    act(() => {
      Object.assign(state, next);
      for (const listener of listeners) {
        listener();
      }
    });
  };
  return { change, confined, desktop, told };
};

const asking = () => [
  listedWindow("game", {
    height: 600,
    pointerConstraint: "confine",
    width: 800,
  }),
];

const at: Rect = { height: 600, width: 800, x: 100, y: 50 };

/** Lets the engine's answers settle. */
const answered = () => act(() => Promise.resolve());

describe("usePointerConfinement", () => {
  it("confines the pointer to the focused window that asked, then says so", async () => {
    const { confined, desktop, told } = fakeDesktop(asking(), "game");

    renderHook(() => usePointerConfinement(desktop, "game", at, true));
    await answered();

    expect(confined).toEqual([[at]]);
    expect(told).toEqual([["game", true]]);
  });

  it("follows the window as it moves, telling the client once", async () => {
    const { confined, desktop, told } = fakeDesktop(asking(), "game");
    const { rerender } = renderHook(
      ({ rect }) => usePointerConfinement(desktop, "game", rect, true),
      { initialProps: { rect: at } },
    );
    await answered();

    rerender({ rect: { ...at } });
    rerender({ rect: { ...at, x: 300 } });
    await answered();

    expect(confined).toEqual([[at], [{ ...at, x: 300 }]]);
    expect(told).toEqual([["game", true]]);
  });

  it("lets go when the keyboard moves away, and says so", async () => {
    const { change, confined, desktop, told } = fakeDesktop(asking(), "game");
    renderHook(() => usePointerConfinement(desktop, "game", at, true));
    await answered();

    change({ focused: "term" });

    expect(confined).toEqual([[at], []]);
    expect(told).toEqual([
      ["game", true],
      ["game", false],
    ]);
  });

  it("lets go when the client withdraws its ask or the window goes", async () => {
    const { change, confined, desktop, told } = fakeDesktop(asking(), "game");
    const { unmount } = renderHook(() =>
      usePointerConfinement(desktop, "game", at, true),
    );
    await answered();
    change({ list: [listedWindow("game")] });
    change({ list: asking() });
    await answered();
    unmount();

    expect(confined).toEqual([[at], [], [at], []]);
    expect(told).toEqual([
      ["game", true],
      ["game", false],
      ["game", true],
      ["game", false],
    ]);
  });

  it("holds nothing while the shell keeps the keyboard", async () => {
    const { confined, desktop, told } = fakeDesktop(asking(), "game");

    renderHook(() => usePointerConfinement(desktop, "game", at, false));
    await answered();

    expect(confined).toEqual([]);
    expect(told).toEqual([]);
  });
});
