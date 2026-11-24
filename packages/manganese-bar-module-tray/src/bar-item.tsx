import { useBar } from "@domicile-desktop/manganese-bar/bar-context";
import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { Tray as TrayRow } from "./Tray";
import { TrayIconsMenu } from "./TrayIconsMenu";
import { useTrayState } from "./tray-context";

/**
 * The tray: application StatusNotifierItems and extension buttons, in one row,
 * in the user's order, and a menu of every icon at its end.
 */
export const Tray = () => {
  const domicile = useDomicile();
  const { screen } = useBar();
  const {
    clicked,
    extensions,
    installed,
    items,
    open,
    opened,
    order,
    pins,
    profile,
  } = useTrayState();
  return (
    <TrayRow
      domicile={domicile}
      end={
        <TrayIconsMenu
          domicile={domicile}
          extensions={extensions}
          installed={installed}
          items={items}
          onActivate={(id) => {
            clicked(screen, id);
          }}
          onOpen={(popup) => {
            open(screen, popup);
          }}
          onPin={pins.pin}
          onSettings={() => {
            // As the launcher runs it.
            domicile.processes.launch(["domicile-settings"]);
          }}
          onUnpin={pins.unpin}
          profile={profile}
          unpinned={pins.unpinned}
        />
      }
      extensions={extensions}
      items={items}
      onActivate={(id) => {
        clicked(screen, id);
      }}
      onMove={order.move}
      onOpen={(popup) => {
        open(screen, popup);
      }}
      onUnpin={pins.unpin}
      opened={opened?.screen === screen ? opened : undefined}
      order={order.order}
      unpinned={pins.unpinned}
    />
  );
};
