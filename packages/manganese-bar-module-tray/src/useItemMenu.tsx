import type { Point } from "@domicile-desktop/component-library/ContextMenu";
import { watchMenu } from "@domicile-desktop/sdk/dbusmenu";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import type { ReactNode } from "react";
import { useState } from "react";

import type { MenuIcons } from "./menu-icons";
import { desktopMenuIcons } from "./menu-icons";
import { TrayMenu } from "./TrayMenu";
import { useMenuIcons } from "./useMenuIcons";
import { useTrayMenu } from "./useTrayMenu";

export type ItemMenu = {
  /** The open menu, to render, or `undefined` while it is closed. */
  opened: ReactNode;
  /**
   * Opens the application's dbusmenu with its corner at `at`, or sends it
   * `ContextMenu` when it has none.
   */
  show: (at: Point) => void;
};

/**
 * An application's own menu, for its tray icon and its row in the tray's
 * menu alike.
 */
export const useItemMenu = (
  domicile: Domicile,
  { bus, id, menu, title }: TrayItem,
  watch: typeof watchMenu = watchMenu,
  icons: MenuIcons = desktopMenuIcons,
): ItemMenu => {
  // Where the open menu hangs from, or `undefined` while it is closed.
  const [at, setAt] = useState<Point | undefined>(undefined);
  const opened = useTrayMenu(domicile, bus, menu, at !== undefined, watch);
  const pictures = useMenuIcons(domicile, opened?.menu, icons);
  return {
    opened: at !== undefined && opened !== undefined && (
      <TrayMenu
        at={at}
        icons={pictures}
        label={title}
        menu={opened.menu}
        onClick={opened.click}
        onClose={() => {
          setAt(undefined);
        }}
        onShow={opened.aboutToShow}
      />
    ),
    show: (point) => {
      if (menu === undefined) {
        domicile.tray.activate(id, "context");
      } else {
        setAt(point);
      }
    },
  };
};
