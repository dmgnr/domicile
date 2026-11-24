import { Button } from "@domicile-desktop/component-library/Button";
import type { watchMenu } from "@domicile-desktop/sdk/dbusmenu";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { TrayItem } from "@domicile-desktop/sdk/tray";

import { css } from "../styled-system/css";
import { center } from "../styled-system/patterns";
import type { MenuIcons } from "./menu-icons";
import { useItemMenu } from "./useItemMenu";

/** The middle button, as `MouseEvent.button` numbers it. */
const MIDDLE_BUTTON = 1;

type Props = {
  /** Where clicks are sent. */
  domicile: Domicile;
  /** The icon, as the compositor last described it. */
  item: TrayItem;
  /** Injectable so tests can answer for the application's menu. */
  watch?: typeof watchMenu | undefined;
  /** Injectable so tests can answer for the menu's icons. */
  icons?: MenuIcons | undefined;
};

/**
 * An application's StatusNotifierItem in the bar's tray.
 *
 * Clicks go to the application: primary is `Activate`, middle
 * `SecondaryActivate`. Secondary opens the application's dbusmenu under the
 * icon, or sends `ContextMenu` for an application without one; so does primary
 * for an item that is only a menu (`ItemIsMenu`). The page's context menu is
 * suppressed so it does not cover the application's.
 *
 * An icon without an image shows the first letter of its title, so it can still
 * be clicked.
 */
export const TrayIcon = ({ domicile, icons, item, watch }: Props) => {
  const { icon, id, itemIsMenu, title } = item;
  const menu = useItemMenu(domicile, item, watch, icons);
  const showMenu = (button: HTMLElement) => {
    const box = button.getBoundingClientRect();
    menu.show({ x: box.left, y: box.bottom });
  };
  return (
    <>
      <Button
        label={title}
        onAuxClick={(event) => {
          if (event.button === MIDDLE_BUTTON) {
            domicile.tray.activate(id, "secondary");
          }
        }}
        onClick={(event) => {
          if (itemIsMenu) {
            showMenu(event.currentTarget);
          } else {
            domicile.tray.activate(id, "primary");
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          showMenu(event.currentTarget);
        }}
        size="sm"
        variant="ghost"
      >
        {icon === undefined ? (
          <span className={letterStyles}>{title.slice(0, 1)}</span>
        ) : (
          <img
            alt=""
            className={imageStyles}
            // Disable native drag; pointer drags reorder the tray.
            draggable={false}
            src={icon}
          />
        )}
      </Button>
      {menu.opened}
    </>
  );
};

// Same size as extension icons, so both read as one row.
const imageStyles = css({ blockSize: 4, inlineSize: 4 });

// The same box as an image, so the row does not shift.
const letterStyles = center({
  blockSize: 4,
  fontSize: "ui",
  inlineSize: 4,
});
