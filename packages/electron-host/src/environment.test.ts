import { describe, expect, it } from "bun:test";

import { readEnvironment } from "./environment";

describe(readEnvironment, () => {
  it("keeps the XDG directories and the engine's socket, and drops the rest", () => {
    expect(
      readEnvironment({
        DOMICILE_ELECTRON_SOCK: "/run/d/electron.sock",
        PATH: "/bin",
        WAYLAND_DISPLAY: "wayland-1",
        XDG_CACHE_HOME: "/c",
        XDG_CONFIG_HOME: "/f",
        XDG_DATA_HOME: "/d",
        XDG_RUNTIME_DIR: "/run/u",
      }),
    ).toEqual({
      DOMICILE_ELECTRON_SOCK: "/run/d/electron.sock",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_CACHE_HOME: "/c",
      XDG_CONFIG_HOME: "/f",
      XDG_DATA_HOME: "/d",
      XDG_RUNTIME_DIR: "/run/u",
    });
  });
});
