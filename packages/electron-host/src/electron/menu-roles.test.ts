import { describe, expect, it } from "bun:test";

import type { RoleWindow } from "./menu-roles";
import { windowRoles } from "./menu-roles";

/** A window that records what its menu's roles asked of it. */
const recordingWindow = (fullscreen: boolean) => {
  const asked: string[] = [];
  const edit = (name: string) => () => {
    asked.push(name);
  };
  const window: RoleWindow = {
    close: edit("close"),
    isFullScreen: () => fullscreen,
    minimize: edit("minimize"),
    setFullScreen: (flag) => {
      asked.push(`fullscreen ${String(flag)}`);
    },
    webContents: {
      copy: edit("copy"),
      cut: edit("cut"),
      delete: edit("delete"),
      paste: edit("paste"),
      pasteAndMatchStyle: edit("pasteAndMatchStyle"),
      redo: edit("redo"),
      reload: edit("reload"),
      selectAll: edit("selectAll"),
      undo: edit("undo"),
    },
  };
  return { asked, window };
};

describe(windowRoles, () => {
  const roles = windowRoles(() => undefined);

  it("makes a window fullscreen from Toggle Full Screen", () => {
    const { asked, window } = recordingWindow(false);
    roles.togglefullscreen(window);
    expect(asked).toEqual(["fullscreen true"]);
  });

  it("takes a fullscreen window out of it from Toggle Full Screen", () => {
    const { asked, window } = recordingWindow(true);
    roles.togglefullscreen(window);
    expect(asked).toEqual(["fullscreen false"]);
  });

  it("minimizes the window from Minimize", () => {
    const { asked, window } = recordingWindow(false);
    roles.minimize(window);
    expect(asked).toEqual(["minimize"]);
  });

  it("reloads the page from Reload and Force Reload", () => {
    const { asked, window } = recordingWindow(false);
    roles.reload(window);
    roles.forceReload(window);
    expect(asked).toEqual(["reload", "reload"]);
  });

  it("runs the Edit menu's roles at the page", () => {
    const { asked, window } = recordingWindow(false);
    roles.undo(window);
    roles.paste(window);
    roles.selectAll(window);
    expect(asked).toEqual(["undo", "paste", "selectAll"]);
  });

  it("does nothing with no window focused, as Electron", () => {
    roles.togglefullscreen(null);
    roles.minimize(null);
    roles.reload(null);
  });

  it("quits the app from Quit", () => {
    const quits: string[] = [];
    windowRoles(() => {
      quits.push("quit");
    }).quit();
    expect(quits).toEqual(["quit"]);
  });
});
