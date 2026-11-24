import type { Option, Result } from "@cprussin/option-result";
import { Drilldown } from "@domicile-desktop/component-library/Drilldown";
import { Panel } from "@domicile-desktop/component-library/Panel";
import { Popover } from "@domicile-desktop/component-library/Popover";
import { useKeepsKeyboard } from "@domicile-desktop/manganese-bar/panel-keyboard";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { useSharedWatch } from "@domicile-desktop/react/use-shared-watch";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type {
  Addressing,
  NetworkInterface,
} from "@domicile-desktop/system-network/interfaces";
import { InterfaceKind } from "@domicile-desktop/system-network/interfaces";
import type { Network as Reading } from "@domicile-desktop/system-network/network";
import { LinkKind } from "@domicile-desktop/system-network/network";
import type { Wifi } from "@domicile-desktop/system-network/wifi";
import { useState } from "react";
import { cva } from "../styled-system/css";
import { LinkIcon, shownOf } from "./link-shown";
import { NetworkPanel } from "./NetworkPanel";
import type { WifiActions } from "./wifi-actions";
import { WIFI_ACTIONS } from "./wifi-actions";

type Props = {
  /** The desk's network, from the network service. */
  network: SharedWatch<Result<Reading, SystemError>>;
  /** The network hardware, from `/sys`. */
  interfaces: SharedWatch<Result<NetworkInterface[], SystemError>>;
  /** Each interface's addresses, read while the panel is open. */
  addresses: SharedWatch<Result<Map<string, Addressing>, SystemError>>;
  /** The Wi-Fi device, read while the panel is open. */
  wifi: SharedWatch<Result<Option<Wifi>, SystemError>>;
  /** The host whose system calls reach the Wi-Fi service. */
  domicile: Domicile;
  /** Injectable so tests can see what the panel asks for. */
  actions?: WifiActions | undefined;
};

/**
 * The network item on the bar: an icon for the primary connection, named on
 * hover with the Wi-Fi network or VPN. Dims with no link, and turns `warning`
 * when the link does not reach the internet or the service fails. A click
 * opens the wired ports and the {@link WifiPanel}.
 *
 * An icon alone, so its width never changes with the name.
 *
 * Draws nothing until the service or the hardware answers, and nothing on a
 * machine with no network hardware.
 */
export const Network = ({
  actions = WIFI_ACTIONS,
  addresses,
  domicile,
  interfaces,
  network,
  wifi,
}: Props) => {
  const reading = useSharedWatch(network);
  const hardware = useSharedWatch(interfaces);
  const ports = hardware?.match({ Err: () => undefined, Ok: (found) => found });
  if (
    (reading === undefined && hardware === undefined) ||
    ports?.length === 0
  ) {
    return undefined;
  } else {
    return (
      <Item
        actions={actions}
        addresses={addresses}
        host={domicile}
        reading={reading}
        wifi={wifi}
        wired={(ports ?? []).filter(({ kind }) => kind === InterfaceKind.Wired)}
      />
    );
  }
};

/**
 * The button and its panel. The panel keeps the keyboard while open, for
 * typing a Wi-Fi password.
 */
const Item = ({
  actions,
  addresses,
  host,
  reading,
  wifi,
  wired,
}: {
  actions: WifiActions;
  addresses: Props["addresses"];
  host: Domicile;
  reading: Result<Reading, SystemError> | undefined;
  wifi: Props["wifi"];
  wired: NetworkInterface[];
}) => {
  const { label, link, online } = shownOf(
    reading,
    wired.some(({ up }) => up),
  );
  const [open, setOpen] = useState(false);
  useKeepsKeyboard(open);
  return (
    <Popover
      align="center"
      onOpenChange={setOpen}
      side="bottom"
      tone="overPhoto"
      tooltip={label}
      trigger={
        <button
          className={triggerStyles({
            linked: link.kind !== LinkKind.None,
            online,
          })}
          type="button"
        >
          <LinkIcon label={label} link={link} />
        </button>
      }
      wide
    >
      <Drilldown>
        <Panel title="Network" width="standard">
          <NetworkPanel
            actions={actions}
            addresses={addresses}
            host={host}
            wifi={wifi}
            wired={wired}
          />
        </Panel>
      </Drilldown>
    </Popover>
  );
};

// Matches the volume item's button.
const triggerStyles = cva({
  base: {
    _hoverOrOpen: { backgroundColor: "fillOverPhoto" },
    alignItems: "center",
    backgroundColor: "transparent",
    blockSize: 7,
    borderRadius: "lg",
    borderStyle: "none",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    inlineSize: 7,
    justifyContent: "center",
    padding: 0,
    transition: "background-color {durations.fast} {easings.default}",
  },
  variants: {
    linked: {
      // Dims the icon alone, so the hover background stays as strong.
      false: { "& > svg": { opacity: "inactive" } },
      true: {},
    },
    online: {
      false: { color: "warning" },
      true: { color: "inherit" },
    },
  },
});
