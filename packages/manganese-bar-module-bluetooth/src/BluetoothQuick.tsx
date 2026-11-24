import type { Result } from "@cprussin/option-result";
import { AnimatedBluetoothIcon } from "@domicile-desktop/component-library/AnimatedBluetoothIcon";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { Loading } from "@domicile-desktop/component-library/Loading";
import { QuickTile } from "@domicile-desktop/component-library/QuickTile";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { useSharedWatch } from "@domicile-desktop/react/use-shared-watch";
import { isAbsent } from "@domicile-desktop/react/watch-presence";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type { Bluetooth as Reading } from "@domicile-desktop/system-bluetooth/bluetooth";

import { cva } from "../styled-system/css";
import { BluetoothPanel } from "./BluetoothPanel";
import type { BluetoothActions } from "./bluetooth-actions";
import { labelOf, unavailableLabelOf } from "./bluetooth-labels";
import { iconStateOf } from "./icon-state";

type GlyphProps = {
  /** The desk's Bluetooth, from BlueZ. */
  bluetooth: SharedWatch<Result<Reading, SystemError>>;
};

/**
 * The Bluetooth icon in the quick settings button, shown only while a device
 * is connected, or in `warning` when BlueZ fails.
 */
export const BluetoothGlyph = ({ bluetooth }: GlyphProps) => {
  const reading = useSharedWatch(bluetooth);
  return reading?.match({
    Err: (error) => (
      <span
        aria-label={unavailableLabelOf(false, error.message)}
        className={glyphStyles({ failed: true })}
        role="img"
      >
        <AnimatedBluetoothIcon size={15} state="off" />
      </span>
    ),
    Ok: (found) => {
      const connected = found.devices.filter((device) => device.connected);
      return connected.length === 0 ? undefined : (
        <span
          aria-label={labelOf(true, connected)}
          className={glyphStyles({ failed: false })}
          role="img"
        >
          <AnimatedBluetoothIcon size={15} state="connected" />
        </span>
      );
    },
  });
};

type TileProps = GlyphProps & {
  /** Whether the machine has Bluetooth hardware, from `/sys`. */
  hardware: SharedWatch<Result<boolean, SystemError>>;
  /** A locked desktop has no details, so the tile only shows the state. */
  locked?: boolean | undefined;
  /** Opens the devices panel, which has the power switch. */
  onMore?: (() => void) | undefined;
};

/**
 * The quick settings tile that opens the devices, naming the connected ones.
 * Bluetooth is nearly always on, so the tile is a way in, not a switch.
 * Nothing until BlueZ answers, and nothing without Bluetooth hardware.
 * Without an adapter it says why and can't be pressed.
 */
export const BluetoothTile = ({
  bluetooth,
  hardware,
  locked = false,
  onMore,
}: TileProps) => {
  const reading = useSharedWatch(bluetooth);
  const present = useSharedWatch(hardware);
  const usable = reading?.match({
    Err: () => undefined,
    Ok: (found) => (found.adapters.length > 0 ? found : undefined),
  });
  if (usable !== undefined) {
    const on = usable.adapters.some(({ powered }) => powered);
    const connected = usable.devices.filter((device) => device.connected);
    return (
      <QuickTile
        detail={detailOf(
          connected.map(({ name }) => name),
          on,
        )}
        icon={
          <AnimatedBluetoothIcon
            size={15}
            state={iconStateOf(connected.length > 0, on)}
          />
        }
        label="Bluetooth"
        lit={connected.length > 0}
        onMore={locked ? undefined : onMore}
      />
    );
  } else if (reading === undefined || isAbsent(present)) {
    return undefined;
  } else {
    return (
      <QuickTile
        detail={reading.match({
          Err: () => "Unavailable",
          Ok: () => "Off",
        })}
        icon={<AnimatedBluetoothIcon size={15} state="off" />}
        label="Bluetooth"
        lit={false}
      />
    );
  }
};

/** The tile's second line: the connected devices, or whether it is on. */
const detailOf = (connected: readonly string[], on: boolean): string => {
  if (connected.length > 0) {
    return connected.join(", ");
  } else {
    return on ? "Not connected" : "Off";
  }
};

const glyphStyles = cva({
  base: { display: "inline-flex", flexShrink: 0 },
  variants: {
    failed: {
      false: {},
      true: { color: "warning" },
    },
  },
});

type DetailsProps = GlyphProps & {
  /** Where requests go. */
  host: Domicile;
  actions: BluetoothActions;
};

/**
 * The quick settings panel's Bluetooth details: the devices, once BlueZ
 * answers, and a plain word on BlueZ's failure, with its words in the tooltip.
 */
export const BluetoothDetails = ({
  actions,
  bluetooth,
  host,
}: DetailsProps) => {
  const reading = useSharedWatch(bluetooth);
  return reading === undefined ? (
    <Loading>Checking Bluetooth…</Loading>
  ) : (
    reading.match({
      Err: (error) => (
        <EmptyState
          detail={error.message}
          hint="Close this and open it again in a moment."
          title="Couldn't read Bluetooth"
          tone="warning"
        />
      ),
      Ok: (found) => (
        <BluetoothPanel actions={actions} bluetooth={found} host={host} />
      ),
    })
  );
};
