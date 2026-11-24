// What the window manager logs at `domicile set-log-level debug shell`: each
// action, and what it changed. Lines name windows, screens and workspaces,
// never what a window says: titles, addresses, file paths and commands stay
// out of the log.

import type { WindowAction, WindowState } from "./window-state";
import { activeIdOf, WindowActionKind } from "./window-state";

/** The action fields a line keeps. Anything else is left out. */
const KEPT: readonly string[] = [
  "appId",
  "id",
  "windowId",
  "desktopId",
  "frame",
  "group",
  "screen",
  "name",
  "from",
  "to",
  "way",
  "direction",
  "edge",
  "axis",
  "layout",
  "mode",
  "global",
  "fullscreen",
  "display",
  "isPrivate",
  "profile",
  "box",
  "area",
  "by",
  "x",
  "y",
  "size",
];

type Scalar = string | number | boolean;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * `value` as a line shows it: a scalar, or an array or flat object of them,
 * such as a box or a node. `undefined` for anything else.
 */
const shown = (value: unknown): string | undefined => {
  if (isScalar(value)) {
    return JSON.stringify(value);
  } else if (Array.isArray(value)) {
    return value.every(isScalar) ? JSON.stringify(value) : undefined;
  } else if (typeof value === "object" && value !== null) {
    return Object.values(value).every(isScalar)
      ? JSON.stringify(value)
      : undefined;
  } else {
    return undefined;
  }
};

/** `action`'s kind and the {@link KEPT} fields in it. */
export const describedAction = (action: WindowAction): string => {
  const fields: Readonly<Record<string, unknown>> = action;
  const kept = KEPT.flatMap((name) => {
    const said = shown(fields[name]);
    return said === undefined ? [] : [`${name}=${said}`];
  });
  return [WindowActionKind[action.kind], ...kept].join(" ");
};

/** What a line says about the desk: who has the keyboard and what shows. */
const outline = (state: WindowState): Readonly<Record<string, string>> => ({
  active: String(activeIdOf(state)),
  clipboard: String(state.clipboardOpen),
  focused: String(state.focusedId),
  launcher: String(state.launcherOpen),
  mode: state.mode,
  overview: String(state.overviewOpen),
  popups: String(state.popups.length),
  scratchpad: JSON.stringify(state.scratchpad),
  screen: state.focused,
  shown: state.screens
    .map(({ name, current }) => `${name}:${current}`)
    .join(","),
  windows: String(state.windows.length),
});

/**
 * What changed from `before` to `after`, as `name=old->new` pairs, or
 * `undefined` when nothing a line says did.
 */
export const describedChange = (
  before: WindowState,
  after: WindowState,
): string | undefined => {
  const was = outline(before);
  const now = outline(after);
  const changed = Object.keys(now).flatMap((name) =>
    was[name] === now[name] ? [] : [`${name}=${was[name]}->${now[name]}`],
  );
  return changed.length === 0 ? undefined : changed.join(" ");
};
