import type { Option, Result } from "@cprussin/option-result";
import { AnimatedWifiIcon } from "@domicile-desktop/component-library/AnimatedWifiIcon";
import { QuickTile } from "@domicile-desktop/component-library/QuickTile";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { useSharedWatch } from "@domicile-desktop/react/use-shared-watch";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type { NetworkInterface } from "@domicile-desktop/system-network/interfaces";
import { InterfaceKind } from "@domicile-desktop/system-network/interfaces";
import type { Network as Reading } from "@domicile-desktop/system-network/network";
import { LinkKind } from "@domicile-desktop/system-network/network";
import type { Wifi } from "@domicile-desktop/system-network/wifi";
import { NetworkIcon } from "@phosphor-icons/react/dist/ssr/Network";

import { cva } from "../styled-system/css";
import { LinkIcon, shownOf } from "./link-shown";
import { speedOf } from "./speed";

type GlyphProps = {
  /** The desk's network, from the network service. */
  network: SharedWatch<Result<Reading, SystemError>>;
  /** The network hardware, from `/sys`. */
  interfaces: SharedWatch<Result<NetworkInterface[], SystemError>>;
};

/**
 * The network icon in the quick settings button, as the network item draws
 * it: dimmed with no link, in `warning` without the internet. Nothing until
 * the service or the hardware answers, and nothing without network hardware.
 */
export const NetworkGlyph = ({ interfaces, network }: GlyphProps) => {
  const reading = useSharedWatch(network);
  const ports = useSharedWatch(interfaces)?.match({
    Err: () => undefined,
    Ok: (found) => found,
  });
  if ((reading === undefined && ports === undefined) || ports?.length === 0) {
    return undefined;
  } else {
    const { label, link, online } = shownOf(
      reading,
      (ports ?? []).some(({ kind, up }) => kind === InterfaceKind.Wired && up),
    );
    return (
      <span
        className={glyphStyles({
          linked: link.kind !== LinkKind.None,
          online,
        })}
      >
        <LinkIcon label={label} link={link} />
      </span>
    );
  }
};

type TileProps = {
  /** The network hardware, from `/sys`. */
  interfaces: SharedWatch<Result<NetworkInterface[], SystemError>>;
  /** The Wi-Fi device, read while the tile shows. */
  wifi: SharedWatch<Result<Option<Wifi>, SystemError>>;
  /** Opens the wired ports and the Wi-Fi panel, which has the Wi-Fi switch. */
  onMore?: (() => void) | undefined;
};

/**
 * The quick settings network tile, which opens the network's details: Wired
 * with a cable in, else Wi-Fi on a machine with a Wi-Fi device, else Wired.
 * Wi-Fi is nearly always on, so the tile is a way in, not a switch. Nothing
 * until Wi-Fi has been read.
 */
export const NetworkTile = ({ interfaces, onMore, wifi }: TileProps) => {
  const read = useSharedWatch(wifi);
  const ports = useSharedWatch(interfaces)?.match({
    Err: () => [],
    Ok: (found) => found,
  });
  if (read === undefined || ports === undefined) {
    return undefined;
  } else {
    const device = read.match({
      Err: () => undefined,
      Ok: (found) =>
        found.match({ None: () => undefined, Some: (radio) => radio }),
    });
    const wired = ports.filter(({ kind }) => kind === InterfaceKind.Wired);
    const cable = wired.find(({ up }) => up);
    if (cable === undefined && device !== undefined) {
      return (
        <QuickTile
          detail={wifiDetailOf(device)}
          icon={<AnimatedWifiIcon bars={3} off={!device.enabled} size={15} />}
          label="Wi-Fi"
          lit={device.connection !== undefined}
          onMore={onMore}
        />
      );
    } else if (wired.length > 0) {
      return (
        <QuickTile
          detail={cable === undefined ? "No cable" : cableDetailOf(cable)}
          icon={<NetworkIcon size={15} weight="bold" />}
          label="Wired"
          lit={cable !== undefined}
          onMore={onMore}
        />
      );
    } else {
      return undefined;
    }
  }
};

const wifiDetailOf = (device: Wifi): string => {
  if (device.enabled) {
    return device.connection?.ssid ?? "Not connected";
  } else {
    return "Off";
  }
};

const cableDetailOf = ({ speed }: NetworkInterface): string =>
  speed === undefined ? "Connected" : `Connected, ${speedOf(speed)}`;

const glyphStyles = cva({
  base: { display: "inline-flex", flexShrink: 0 },
  variants: {
    linked: {
      false: { opacity: "inactive" },
      true: {},
    },
    online: {
      false: { color: "warning" },
      true: {},
    },
  },
});
