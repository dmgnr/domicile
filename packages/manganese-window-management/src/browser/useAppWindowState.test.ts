import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook } from "@testing-library/react";

import { useAppWindowState } from "./useAppWindowState";

/** Browser window "1", and the window states the hook reported for it. */
const setUp = () => {
  const host = new FakeDomicileHost();
  host.openBrowser("https://claude.test/");
  const reports = () =>
    host.calls.filter(([name]) => name === "setBrowserWindowState");
  return { host, reports };
};

describe("useAppWindowState", () => {
  it("fills the screen when the app asks, and stops when it asks again", () => {
    const { host } = setUp();
    const asked: boolean[] = [];
    renderHook(() =>
      useAppWindowState(host.domicile, "1", false, (fullscreen) => {
        asked.push(fullscreen);
      }),
    );

    act(() => {
      host.setWantedState("1", { wantsFullscreen: true });
    });
    act(() => {
      host.setWantedState("1", { wantsFullscreen: false });
    });

    expect(asked).toEqual([true, false]);
  });

  it("asks nothing for a window whose app wants nothing", () => {
    const { host } = setUp();
    const asked: boolean[] = [];
    renderHook(() =>
      useAppWindowState(host.domicile, "1", false, (fullscreen) => {
        asked.push(fullscreen);
      }),
    );

    act(() => {
      host.setWantedState("1", { wantsMaximized: true });
    });

    expect(asked).toEqual([]);
  });

  it("fills the screen at once for a window opened wanting it", () => {
    const { host } = setUp();
    host.setWantedState("1", { wantsFullscreen: true });
    const asked: boolean[] = [];

    renderHook(() =>
      useAppWindowState(host.domicile, "1", false, (fullscreen) => {
        asked.push(fullscreen);
      }),
    );

    expect(asked).toEqual([true]);
  });

  it("reports what the window is, as it mounts and on each change", () => {
    const { host, reports } = setUp();
    const { rerender } = renderHook(
      ({ fullscreen }) =>
        useAppWindowState(host.domicile, "1", fullscreen, () => undefined),
      { initialProps: { fullscreen: false } },
    );

    rerender({ fullscreen: true });
    rerender({ fullscreen: true });
    rerender({ fullscreen: false });

    expect(reports()).toEqual([
      ["setBrowserWindowState", "1", false, false, false],
      ["setBrowserWindowState", "1", false, false, true],
      ["setBrowserWindowState", "1", false, false, false],
    ]);
  });
});
