// Dropping a dragged tiled window or group onto a window, as in sway's
// `tiling_drag`.
//
// Dropping on the middle puts the window in the target's tab group, after it.
// Dropping on an edge puts the window on that side: in the target's container
// if it runs that way, else in a new split with the target.

import type { Direction } from "../direction";
import { axisOf as axisOfDirection, isForward } from "../direction";
import type { Container, LayoutNode } from "./node";
import {
  axisOf,
  Layout,
  LayoutNode as Node,
  NodeKind,
  showsOneChild,
  splitFor,
  withChildAt,
} from "./node";
import type { NodeRef, Path } from "./path";
import { nodeAt, pathToRef, replacedAt } from "./path";
import { withoutAt } from "./remove";
import type { Tiling } from "./tiling";
import {
  focusedWindowIn,
  selects,
  withCommandsOn,
  withFocusOn,
} from "./tiling";

/** Where a drop on the edge of a tab goes. */
export enum Beside {
  /** Into the tab's strip, before or after it. */
  InStrip,
  /** Out of the strip: the tab's place splits with the dropped node. */
  Apart,
}

/**
 * The tiling with the node `moving` names dropped on the `edge` of the node
 * `target` names, or its middle when `edge` is `undefined`. Focus goes to the
 * moved node, and commands stay on it only if it was selected (see `landed`).
 *
 * Unchanged when `target` is `moving` or inside it. Throws if either is not
 * tiled here.
 */
export const droppedOn = (
  tiling: Tiling,
  moving: NodeRef,
  target: NodeRef,
  edge: Direction | undefined,
  beside: Beside = Beside.InStrip,
): Tiling => {
  const root = tiledRoot(tiling);
  const from = pathToRef(root, moving);
  const to = pathToRef(root, target);
  const node = nodeAt(root, from);
  if (startsWith(to, from)) {
    return tiling;
  } else {
    return landed(
      { ...tiling, root: movedOnto(root, from, to, target, edge, beside) },
      node,
      selects(tiling, from),
    );
  }
};

/**
 * The tiling with `node`, dragged in from another workspace or layer, dropped
 * on the `edge` of the node `target` names, or its middle when `edge` is
 * `undefined`. Focus goes to `node`, and commands stay on it if it was
 * `selected` where it came from (see `landed`).
 *
 * Throws if `target` is not tiled here.
 */
export const arrivedOn = (
  tiling: Tiling,
  node: LayoutNode,
  selected: boolean,
  target: NodeRef,
  edge: Direction | undefined,
  beside: Beside = Beside.InStrip,
): Tiling => {
  const root = tiledRoot(tiling);
  return landed(
    {
      ...tiling,
      root: placed(root, pathToRef(root, target), node, edge, beside),
    },
    node,
    selected,
  );
};

/**
 * Focuses `node`, just dropped. A `selected` node keeps the commands, so a
 * dropped group selected before the drag stays selected; otherwise they go to
 * its focused window alone.
 */
const landed = (tiling: Tiling, node: LayoutNode, selected: boolean): Tiling =>
  selected
    ? withCommandsOn(tiling, node)
    : withFocusOn(tiling, focusedWindowIn(node));

/**
 * Removes the node at `from` and drops it on the `edge` of `target`, or its
 * middle when `edge` is `undefined`.
 *
 * Removes it first, like a keyed `move`, so the tree collapses as after a
 * close before the target is located. A tab moved beside another tab of its
 * strip only moves along it, so a strip of two keeps a nested group in it. A
 * node dropped beside a group that holds only it takes the group's place.
 */
const movedOnto = (
  root: LayoutNode,
  from: Path,
  to: Path,
  target: NodeRef,
  edge: Direction | undefined,
  beside: Beside,
): LayoutNode => {
  const around = from.slice(0, -1);
  const parent = nodeAt(root, around);
  const fromAt = from.at(-1);
  const toAt = to.at(-1);
  if (
    edge !== undefined &&
    beside === Beside.InStrip &&
    fromAt !== undefined &&
    toAt !== undefined &&
    parent.kind === NodeKind.Container &&
    showsOneChild(parent.layout) &&
    axisOf(parent.layout) === axisOfDirection(edge) &&
    to.length === from.length &&
    startsWith(to, around)
  ) {
    return replacedAt(root, around, () =>
      movedAlong(parent, fromAt, toAt, isForward(edge)),
    );
  } else if (
    startsWith(from, to) &&
    withoutAt(nodeAt(root, to), from.slice(to.length)) === undefined
  ) {
    // The group it is dropped beside holds only it, and goes with it.
    return replacedAt(root, to, () => nodeAt(root, from));
  } else {
    const rest = withoutAt(root, from);
    if (rest === undefined) {
      // Unreachable: the target is still in the tree.
      throw new Error(`layout tree: dropping on ${target.id} left nothing`);
    } else {
      // A group around the moved node keeps its path, but its ref may name a
      // window that just left it.
      const at = startsWith(from, to) ? to : pathToRef(rest, target);
      return placed(rest, at, nodeAt(root, from), edge, beside);
    }
  }
};

/**
 * The tab container with its child at `from` moved before or, when `forward`,
 * after its child at `to`.
 */
const movedAlong = (
  container: Container,
  from: number,
  to: number,
  forward: boolean,
): Container => {
  const { children } = container;
  const moving = children[from];
  const target = children[to];
  if (moving === undefined || target === undefined) {
    throw new Error("layout tree: a tab moved along a strip is not in it");
  } else {
    const rest = children.filter((_, at) => at !== from);
    return withChildAt(
      { ...container, children: rest },
      rest.indexOf(target) + (forward ? 1 : 0),
      moving,
    );
  }
};

/**
 * Puts `moving` on the `edge` side of the node at `at`, or in its tab group
 * when `edge` is `undefined`.
 */
const placed = (
  root: LayoutNode,
  at: Path,
  moving: LayoutNode,
  edge: Direction | undefined,
  beside: Beside,
): LayoutNode =>
  edge === undefined
    ? joined(root, at, moving)
    : placedBeside(root, at, moving, edge, beside);

/**
 * Puts `moving` just after the node at `at` in its tab group. A node alone in
 * its group makes that group a tab group; any other node gets a tab group of
 * the two.
 */
const joined = (root: LayoutNode, at: Path, moving: LayoutNode): LayoutNode => {
  const index = at.at(-1);
  const around = at.slice(0, -1);
  const parent = index === undefined ? undefined : nodeAt(root, around);
  if (
    parent?.kind === NodeKind.Container &&
    index !== undefined &&
    (showsOneChild(parent.layout) || parent.children.length === 1)
  ) {
    return replacedAt(root, around, () =>
      withChildAt(
        showsOneChild(parent.layout)
          ? parent
          : Node.Container(Layout.Tabbed, parent.children),
        index + 1,
        moving,
      ),
    );
  } else {
    return replacedAt(root, at, (node) =>
      Node.Container(Layout.Tabbed, [node, moving], 1),
    );
  }
};

/**
 * Puts `moving` on the `edge` side of the node at `at`: in its parent if the
 * parent runs along that axis, else in a new split with the node (also when
 * there is no parent). A tab group of one becomes that split, unless it is a
 * tab itself. A tab dropped `Apart` from always splits with it.
 */
const placedBeside = (
  root: LayoutNode,
  at: Path,
  moving: LayoutNode,
  edge: Direction,
  beside: Beside,
): LayoutNode => {
  const target = nodeAt(root, at);
  const [only, ...others] =
    target.kind === NodeKind.Container &&
    showsOneChild(target.layout) &&
    !isTab(root, at)
      ? target.children
      : [];
  if (only !== undefined && others.length === 0) {
    return replacedAt(root, at, () => splitWith(only, moving, edge));
  } else if (beside === Beside.Apart && isTab(root, at)) {
    return replacedAt(root, at, (node) => splitWith(node, moving, edge));
  } else {
    return besideNode(root, at, moving, edge);
  }
};

/** A split of `node` with `moving` on its `edge` side, focusing `moving`. */
const splitWith = (
  node: LayoutNode,
  moving: LayoutNode,
  edge: Direction,
): Container => {
  const forward = isForward(edge);
  return Node.Container(
    splitFor(axisOfDirection(edge)),
    forward ? [node, moving] : [moving, node],
    forward ? 1 : 0,
  );
};

/** Whether the node at `at` is a tab of a tabbed or stacking container. */
const isTab = (root: LayoutNode, at: Path): boolean => {
  const parent = at.length === 0 ? undefined : nodeAt(root, at.slice(0, -1));
  return parent?.kind === NodeKind.Container && showsOneChild(parent.layout);
};

/** {@link placedBeside} for any node but a tab group of one. */
const besideNode = (
  root: LayoutNode,
  at: Path,
  moving: LayoutNode,
  edge: Direction,
): LayoutNode => {
  const index = at.at(-1);
  const around = at.slice(0, -1);
  const parent = index === undefined ? undefined : nodeAt(root, around);
  const axis = axisOfDirection(edge);
  const forward = isForward(edge);
  if (
    parent?.kind === NodeKind.Container &&
    index !== undefined &&
    axisOf(parent.layout) === axis
  ) {
    return replacedAt(root, around, () =>
      withChildAt(parent, forward ? index + 1 : index, moving),
    );
  } else if (
    parent?.kind === NodeKind.Container &&
    parent.children.length === 1
  ) {
    // The target alone in its group: the drop relays the group, rather than
    // nesting a split in it.
    return replacedAt(root, around, () =>
      Node.Container(
        splitFor(axis),
        forward ? [...parent.children, moving] : [moving, ...parent.children],
        forward ? 1 : 0,
      ),
    );
  } else {
    return replacedAt(root, at, (node) =>
      Node.Container(
        splitFor(axis),
        forward ? [node, moving] : [moving, node],
        forward ? 1 : 0,
      ),
    );
  }
};

/** Whether `path` runs through `prefix`, or is it. */
const startsWith = (path: Path, prefix: Path): boolean =>
  prefix.length <= path.length && prefix.every((step, at) => path[at] === step);

const tiledRoot = ({ root }: Tiling): LayoutNode => {
  if (root === undefined) {
    throw new Error("layout tree: nothing is tiled to drop a window on");
  } else {
    return root;
  }
};
