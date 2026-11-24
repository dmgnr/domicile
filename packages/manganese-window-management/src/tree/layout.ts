// Layout commands: `splith`, `splitv`, `layout tabbed`, `layout stacking`,
// `layout toggle split` and manganese's `group`.
//
// A split moves a tab out of its group, beside it. A layout changes the
// container the focus is in (the node itself if `focus parent` selected a
// container), as in sway. A lone window gets a container.

import type { Axis } from "../direction";
import type { Container, LayoutNode } from "./node";
import {
  Layout,
  LayoutNode as Node,
  NodeKind,
  showsOneChild,
  splitFor,
  withChildAt,
} from "./node";
import { nodeAt, replacedAt } from "./path";
import { withoutAt } from "./remove";
import type { Tiling } from "./tiling";
import {
  focusChainOf,
  focusedChildIn,
  focusedWindowIn,
  focusPathOf,
  withCommandsOn,
  withFocusOn,
} from "./tiling";

/**
 * `splith` / `splitv`: moves the focus out of its tab group, to the group's
 * right or below it. Unchanged unless the focus is one of several tabs.
 */
export const split = (tiling: Tiling, axis: Axis): Tiling => {
  const { root } = tiling;
  const path = root === undefined ? [] : focusPathOf(root, tiling.depth);
  const around = path.slice(0, -1);
  const group =
    root === undefined || path.length === 0 ? undefined : nodeAt(root, around);
  if (
    root === undefined ||
    group?.kind !== NodeKind.Container ||
    !showsOneChild(group.layout) ||
    group.children.length === 1
  ) {
    return tiling;
  } else {
    const moving = nodeAt(root, path);
    const rest = withoutAt(root, path);
    if (rest === undefined) {
      // Unreachable: the group keeps its other tabs.
      throw new Error("layout tree: splitting out a tab left nothing");
    } else {
      return withCommandsOn(
        { ...tiling, root: besideGroup(rest, around, moving, axis) },
        moving,
      );
    }
  }
};

// Puts `moving` after the node at `at`: in the split around it if that runs
// along `axis`, else in a new split of the two.
const besideGroup = (
  root: LayoutNode,
  at: readonly number[],
  moving: LayoutNode,
  axis: Axis,
): LayoutNode => {
  const index = at.at(-1);
  const parent =
    index === undefined ? undefined : nodeAt(root, at.slice(0, -1));
  return index !== undefined &&
    parent?.kind === NodeKind.Container &&
    parent.layout === splitFor(axis)
    ? replacedAt(root, at.slice(0, -1), () =>
        withChildAt(parent, index + 1, moving),
      )
    : replacedAt(root, at, (node) =>
        Node.Container(splitFor(axis), [node, moving], 1),
      );
};

/**
 * `group`: turns the focused tab into a group of its own, in the same slot, so
 * windows opened or moved into it nest there. Unchanged unless the focus is a
 * window that is one of several tabs.
 */
export const subgrouped = (tiling: Tiling): Tiling => {
  const { root } = tiling;
  const path = root === undefined ? [] : focusPathOf(root, tiling.depth);
  const around = path.slice(0, -1);
  const group =
    root === undefined || path.length === 0 ? undefined : nodeAt(root, around);
  const focused = root === undefined ? undefined : nodeAt(root, path);
  return root === undefined ||
    focused?.kind !== NodeKind.Window ||
    group?.kind !== NodeKind.Container ||
    !showsOneChild(group.layout) ||
    group.children.length === 1
    ? tiling
    : withCommandsOn(
        {
          ...tiling,
          root: replacedAt(root, path, () =>
            Node.Container(group.layout, [focused]),
          ),
        },
        focused,
      );
};

/**
 * `layout tabbed` / `layout stacking` on the container around the focus. A
 * group already in `layout` passes it to the split around it, merging that
 * split's groups.
 */
export const laidOut = (tiling: Tiling, layout: Layout): Tiling =>
  rearranged(
    tiling,
    (root, path) => splitAroundSame(root, path, layout),
    (root, at) => relaid(root, at, () => layout),
  );

/**
 * `layout toggle split`: a row becomes a column, and anything else a row. For
 * a window alone in its group, the split around the group.
 */
export const splitToggled = (tiling: Tiling): Tiling =>
  rearranged(tiling, aloneIn, (root, at) =>
    relaid(root, at, (was) =>
      was === Layout.SplitH ? Layout.SplitV : Layout.SplitH,
    ),
  );

// The path to the split around the group `relaid` would change, when that
// group is already in `layout`. Else `path`.
const splitAroundSame = (
  root: LayoutNode,
  path: readonly number[],
  layout: Layout,
): readonly number[] => {
  const group =
    nodeAt(root, path).kind === NodeKind.Container ? path : path.slice(0, -1);
  const node = nodeAt(root, group);
  const around =
    group.length === 0 ? undefined : nodeAt(root, group.slice(0, -1));
  return node.kind === NodeKind.Container &&
    node.layout === layout &&
    around?.kind === NodeKind.Container &&
    !showsOneChild(around.layout)
    ? group.slice(0, -1)
    : path;
};

// The path to the container around the group of a window alone in its group,
// which `relaid` then changes. Else `path`.
const aloneIn = (
  root: LayoutNode,
  path: readonly number[],
): readonly number[] => {
  const around = path.slice(0, -1);
  const group = path.length < 2 ? undefined : nodeAt(root, around);
  return nodeAt(root, path).kind === NodeKind.Window &&
    group?.kind === NodeKind.Container &&
    showsOneChild(group.layout) &&
    group.children.length === 1
    ? around.slice(0, -1)
    : path;
};

// Gives the container around the focus a new layout, creating one for a lone
// window.
const relaid = (
  root: LayoutNode,
  path: readonly number[],
  into: (was: Layout) => Layout,
): LayoutNode => {
  const focused = nodeAt(root, path);
  if (focused.kind === NodeKind.Container) {
    return replacedAt(root, path, () => relaidContainer(focused, into));
  } else {
    const parent = path.slice(0, -1);
    const around = nodeAt(root, parent);
    if (around.kind === NodeKind.Container) {
      return replacedAt(root, parent, () => relaidContainer(around, into));
    } else {
      // A lone window gets a new container. A toggle treats it as `SplitH`.
      return replacedAt(root, parent, (node) =>
        Node.Container(into(Layout.SplitH), [node]),
      );
    }
  }
};

// The container in its new layout. A split turning into tabs or a stack merges
// the groups it held, so their windows become its tabs.
const relaidContainer = (
  container: Container,
  into: (was: Layout) => Layout,
): Container => {
  const layout = into(container.layout);
  return showsOneChild(layout) && !showsOneChild(container.layout)
    ? merged(container, layout)
    : Node.Container(
        layout,
        container.children,
        container.focused,
        container.fractions,
      );
};

const merged = (container: Container, layout: Layout): Container => {
  const tabs = container.children.map((child) =>
    child.kind === NodeKind.Container && showsOneChild(child.layout)
      ? child.children
      : [child],
  );
  const shown = focusedChildIn(container);
  const within =
    shown.kind === NodeKind.Container && showsOneChild(shown.layout)
      ? shown.focused
      : 0;
  return Node.Container(
    layout,
    tabs.flat(),
    tabs.slice(0, container.focused).flat().length + within,
  );
};

// Edits the tree at the path `at` picks from the focus path, then puts
// commands back on the same window, or on the container edited: a relaid
// container keeps its path.
const rearranged = (
  tiling: Tiling,
  at: (root: LayoutNode, path: readonly number[]) => readonly number[],
  into: (root: LayoutNode, at: readonly number[]) => LayoutNode,
): Tiling => {
  const { root } = tiling;
  if (root === undefined) {
    return tiling;
  } else {
    const path = focusPathOf(root, tiling.depth);
    const target = at(root, path);
    const after = withFocusOn(
      { ...tiling, root: into(root, target) },
      focusedWindowIn(root),
    );
    return path.length === focusChainOf(root).length
      ? after
      : { ...after, depth: target.length };
  }
};
