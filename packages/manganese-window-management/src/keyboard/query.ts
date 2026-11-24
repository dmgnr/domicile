// The questions `domicile send-shell` can ask Manganese, which answer with
// JSON for scripts, as `swaymsg -t get_workspaces` and `get_tree` do. Each
// monitor's page holds the whole desk's state, so any page answers.

import type { ShellCommandHelp } from "@domicile-desktop/sdk/shell-command";

import { WindowKind } from "../window";
import type { WindowState } from "../window-state";
import { focusedOn, windowsOn } from "../workspace";

/** A question for Manganese. */
export enum Query {
  /** Each workspace: where it is, whether it shows, and its windows. */
  Workspaces,
  /** The screens, every workspace's tiling and floats, and the windows. */
  Tree,
}

const QUERIES: ReadonlyMap<string, Query> = new Map([
  ["get-workspaces", Query.Workspaces],
  ["get-tree", Query.Tree],
]);

/** The queries, for `domicile list-shell-commands`. */
export const QUERY_HELP: readonly ShellCommandHelp[] = [
  {
    description:
      "Print each workspace as JSON: its screen, whether it shows, and its windows.",
    usage: "get-workspaces",
  },
  {
    description:
      "Print the screens, each workspace's tiling and floats, and every window as JSON.",
    usage: "get-tree",
  },
];

/** The query `args` asks, or `undefined` when it is a command instead. */
export const parseQuery = (args: readonly string[]): Query | undefined =>
  args.length === 1 ? QUERIES.get(args[0] ?? "") : undefined;

/** `query`'s answer about `state`, as pretty JSON. */
export const answerQuery = (query: Query, state: WindowState): string =>
  JSON.stringify(answered(query, state), undefined, 2);

const answered = (query: Query, state: WindowState): unknown => {
  switch (query) {
    case Query.Workspaces: {
      return workspacesOf(state);
    }
    case Query.Tree: {
      return {
        focused_screen: state.focused,
        mode: state.mode,
        scratchpad: state.scratchpad,
        screens: state.screens.map(({ box, current, name }) => ({
          box,
          name,
          workspace: current,
        })),
        windows: state.windows.map((window) => ({
          id: window.id,
          kind: window.kind === WindowKind.App ? "native" : "browser",
          title: window.title,
          ...(window.kind === WindowKind.App ? { app_id: window.appId } : {}),
        })),
        workspaces: state.workspaces.map((workspace) => ({
          floats: workspace.floats,
          focused_window: focusedOn(workspace) ?? null,
          fullscreen: workspace.fullscreen ?? null,
          name: workspace.name,
          tiling: workspace.tiling,
        })),
      };
    }
  }
};

const workspacesOf = (state: WindowState) => {
  const keyed = state.screens.find(({ name }) => name === state.focused);
  return state.workspaces.map((workspace) => {
    const showing = state.screens.find(
      ({ current }) => current === workspace.name,
    );
    return {
      focused: keyed?.current === workspace.name,
      focused_window: focusedOn(workspace) ?? null,
      name: workspace.name,
      screen: showing?.name ?? state.homes[workspace.name] ?? null,
      visible: showing !== undefined,
      windows: windowsOn(workspace),
    };
  });
};
