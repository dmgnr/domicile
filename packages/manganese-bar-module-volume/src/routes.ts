import type {
  AudioChoice,
  AudioDevice,
} from "@domicile-desktop/system-audio/audio";

import { primary } from "./primary";

/** Somewhere sound can go, or come from: a device, through one of its ports. */
export type Route = {
  device: AudioDevice;
  /** Absent for a device without ports. */
  port: AudioChoice | undefined;
  /** Unique among the routes. */
  key: string;
  /** The port's name, such as "Speakers", else the device's. */
  label: string;
  /** The device's name, when another route has the same label. */
  detail: string | undefined;
  /** Whether sound goes this way now. */
  picked: boolean;
};

/** A route before it is told apart from the others. */
type Way = Pick<Route, "device" | "label" | "port">;

/**
 * Each way to send or take sound, as people name them: "Speakers",
 * "Headphones", rather than the card that has them.
 *
 * A port whose jack is empty is left out, unless it is in use. Monitors are
 * left out; they record an output, which is not a choice of input. So is the
 * hardware behind a filter, such as speaker correction, unless it is in use:
 * picking it would skip the filter.
 */
export const routesOf = (devices: readonly AudioDevice[]): readonly Route[] => {
  const unmonitored = devices.filter((device) => !device.monitor);
  const current = primary(unmonitored);
  const shown = unmonitored.filter(
    (device) => !device.filtered || device === current,
  );
  const routes = shown.flatMap((device): Way[] =>
    device.ports.length === 0
      ? [{ device, label: device.description, port: undefined }]
      : device.ports
          .filter((port) => port.available || port.name === device.port)
          .map((port) => ({ device, label: port.description, port })),
  );
  return routes.map(({ device, label, port }) => ({
    detail:
      routes.filter((route) => route.label === label).length > 1
        ? device.description
        : undefined,
    device,
    key: port === undefined ? device.id : `${device.id} ${port.name}`,
    label,
    picked:
      device === current && (port === undefined || port.name === device.port),
    port,
  }));
};
