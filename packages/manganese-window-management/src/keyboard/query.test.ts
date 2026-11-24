import { describe, expect, it } from "bun:test";

import { appWindowId, ShellWindow } from "../window";
import { NO_WINDOWS } from "../window-state";
import { answerQuery, parseQuery, QUERY_HELP, Query } from "./query";

describe("parseQuery", () => {
  it("reads each query it describes", () => {
    expect(QUERY_HELP.map(({ usage }) => parseQuery([usage]))).toStrictEqual([
      Query.Workspaces,
      Query.Tree,
    ]);
  });

  it("leaves commands, and a query given words, to the commands", () => {
    expect(parseQuery(["focus", "left"])).toBeUndefined();
    expect(parseQuery(["get-tree", "now"])).toBeUndefined();
  });
});

describe("answerQuery", () => {
  const state = {
    ...NO_WINDOWS,
    focused: "DP-1",
    homes: { "1": "DP-1" },
    screens: [
      {
        box: { height: 1080, width: 1920, x: 0, y: 0 },
        current: "1",
        name: "DP-1",
      },
    ],
  };

  it("lists each workspace with its screen, whether it shows, and its windows", () => {
    const workspaces = JSON.parse(answerQuery(Query.Workspaces, state));

    expect(workspaces[0]).toStrictEqual({
      focused: true,
      focused_window: null,
      name: "1",
      screen: "DP-1",
      visible: true,
      windows: [],
    });
    expect(workspaces[1]).toMatchObject({
      focused: false,
      screen: null,
      visible: false,
    });
  });

  it("gives the screens, the workspaces' layout and the windows", () => {
    const tree = JSON.parse(
      answerQuery(Query.Tree, {
        ...state,
        windows: [ShellWindow.App("foot", "~")],
      }),
    );

    expect(tree.focused_screen).toBe("DP-1");
    expect(tree.screens).toStrictEqual([
      {
        box: { height: 1080, width: 1920, x: 0, y: 0 },
        name: "DP-1",
        workspace: "1",
      },
    ]);
    expect(tree.windows).toStrictEqual([
      { app_id: "foot", id: appWindowId("foot"), kind: "native", title: "~" },
    ]);
    expect(tree.workspaces[0]).toMatchObject({
      focused_window: null,
      name: "1",
    });
  });
});
