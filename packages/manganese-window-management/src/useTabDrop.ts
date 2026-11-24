// A page's text, link or image dragged onto a tab strip opens a new tab
// there. The aim is the line a dragged window's tab shows (`DropIndicator`).

import type { DragEvent } from "react";
import { useMemo } from "react";

import type { Direction } from "./direction";
import { droppedUrl, tabDropKindOf } from "./tab-drop";
import type { Aim, DropTargets } from "./tiled/aim";
import { AimKind, NO_WINDOW, tabAimAt } from "./tiled/aim";
import type { NodeRef } from "./tree/path";

type Options = {
  /** What a tiled group can be dropped on, on every screen. */
  targets: DropTargets;
  /** Where the drop would open its tab, or `undefined` for nowhere. */
  onAim: (aim: Aim | undefined) => void;
  /** Opens `url` in a new tab beside `target`'s, on its `edge`. */
  onTabDrop: (target: NodeRef, edge: Direction, url: string) => void;
};

/** The drag handlers for the stage, which every strip and tab is in. */
export const useTabDrop = ({ targets, onAim, onTabDrop }: Options) =>
  useMemo(() => {
    /** The tab a drag at the event would open beside, if it opens one. */
    const aimOf = (event: DragEvent) => {
      const aim =
        tabDropKindOf([...event.dataTransfer.types]) === undefined
          ? undefined
          : tabAimAt(targets, NO_WINDOW, event.clientX, event.clientY);
      return aim?.kind === AimKind.Tab ? aim : undefined;
    };
    return {
      onDragLeave: (event: DragEvent) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          onAim(undefined);
        }
      },
      onDragOver: (event: DragEvent) => {
        const aim = aimOf(event);
        if (aim !== undefined) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
        onAim(aim);
      },
      onDrop: (event: DragEvent) => {
        const aim = aimOf(event);
        onAim(undefined);
        if (aim !== undefined) {
          event.preventDefault();
          const url = droppedUrl(
            event.dataTransfer.getData("text/uri-list"),
            event.dataTransfer.getData("text/plain"),
          );
          if (url !== undefined) {
            onTabDrop(aim.node, aim.edge, url);
          }
        }
      },
    };
  }, [targets, onAim, onTabDrop]);
