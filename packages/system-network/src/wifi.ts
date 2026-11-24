// The Wi-Fi device from whichever service manages it, NetworkManager or iwd,
// and the requests that change it. It also forwards the Wi-Fi types, which
// live in `wifi-state` so the backends can import them without a cycle. See
// docs/SHELL-SYSTEM-ACCESS.md.

import type { Option, Result } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";
import type { SystemError } from "@domicile-desktop/sdk/system";

import { hasOwner } from "./has-owner";
import {
  connectIwdWifi,
  disconnectIwdWifi,
  forgetIwdWifi,
  scanIwdWifi,
  setIwdWifiAutoJoin,
  setIwdWifiEnabled,
  watchIwdWifi,
} from "./iwd-wifi";
import {
  connectNetworkManagerWifi,
  disconnectNetworkManagerWifi,
  forgetNetworkManagerWifi,
  scanNetworkManagerWifi,
  setNetworkManagerWifiAutoJoin,
  setNetworkManagerWifiEnabled,
  watchNetworkManagerWifi,
} from "./networkmanager-wifi";
import type {
  SavedWifi,
  Wifi,
  WifiDesktop,
  WifiDevice,
  WifiNetwork,
} from "./wifi-state";
import { WifiBackend } from "./wifi-state";

export type {
  Ip,
  SavedWifi,
  Wifi,
  WifiConnection,
  WifiDesktop,
  WifiDevice,
  WifiNetwork,
} from "./wifi-state";
export { WifiBackend, WifiSecurity } from "./wifi-state";

/** Each backend's bus name, in the order they are tried. */
const BACKENDS: readonly (readonly [string, WifiBackend])[] = [
  ["org.freedesktop.NetworkManager", WifiBackend.NetworkManager],
  ["net.connman.iwd", WifiBackend.Iwd],
];

/**
 * Calls `onWifi` with the Wi-Fi device now and after each change, and returns
 * a function that stops watching.
 *
 * Watches the first of NetworkManager and iwd on the system bus when called.
 * `None` is no Wi-Fi device, or neither service: wpa_supplicant alone is not
 * controlled. An `Err` is a D-Bus failure.
 */
export const watchWifi = (
  domicile: WifiDesktop,
  onWifi: (wifi: Result<Option<Wifi>, SystemError>) => void,
): (() => void) => {
  const watch: Watch = { stop: undefined, stopped: false };
  detect(domicile, BACKENDS)
    .then((found) => {
      if (!watch.stopped) {
        found.match({
          Err: (error) => {
            onWifi(Err(error));
          },
          Ok: (backend) => {
            backend.match({
              None: () => {
                onWifi(Ok(None()));
              },
              Some: (chosen) => {
                watch.stop = watchBackend(chosen)(domicile, onWifi);
              },
            });
          },
        });
      }
    })
    .catch((error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: surfacing a background failure
      console.error("Failed to find a Wi-Fi service", error);
    });
  return () => {
    watch.stopped = true;
    watch.stop?.();
  };
};

/** Turn the radio on or off. */
export const setWifiEnabled = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
  enabled: boolean,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return setNetworkManagerWifiEnabled(domicile, wifi, enabled);
    case WifiBackend.Iwd:
      return setIwdWifiEnabled(domicile, wifi, enabled);
  }
};

/** Ask for a scan. Networks it finds arrive through the watch. */
export const scanWifi = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return scanNetworkManagerWifi(domicile, wifi);
    case WifiBackend.Iwd:
      return scanIwdWifi(domicile, wifi);
  }
};

/**
 * Join `network`. A secured network with no saved profile needs `passphrase`;
 * the call throws without one.
 */
export const connectWifi = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
  network: WifiNetwork,
  passphrase: string | undefined,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return connectNetworkManagerWifi(domicile, wifi, network, passphrase);
    case WifiBackend.Iwd:
      return connectIwdWifi(domicile, wifi, network, passphrase);
  }
};

/** Leave the current network. */
export const disconnectWifi = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return disconnectNetworkManagerWifi(domicile, wifi);
    case WifiBackend.Iwd:
      return disconnectIwdWifi(domicile, wifi);
  }
};

/** Forget a saved network, so joining it again asks for its password. */
export const forgetWifi = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
  saved: SavedWifi,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return forgetNetworkManagerWifi(domicile, wifi, saved);
    case WifiBackend.Iwd:
      return forgetIwdWifi(domicile, wifi, saved);
  }
};

/** Whether the service joins a saved network by itself when it is in range. */
export const setWifiAutoJoin = (
  domicile: WifiDesktop,
  wifi: WifiDevice,
  saved: SavedWifi,
  autoJoin: boolean,
): Promise<Result<"done", SystemError>> => {
  switch (wifi.backend) {
    case WifiBackend.NetworkManager:
      return setNetworkManagerWifiAutoJoin(domicile, wifi, saved, autoJoin);
    case WifiBackend.Iwd:
      return setIwdWifiAutoJoin(domicile, wifi, saved, autoJoin);
  }
};

/** A watch's state, shared by its detection and its stop function. */
type Watch = { stop: (() => void) | undefined; stopped: boolean };

const watchBackend = (backend: WifiBackend): typeof watchNetworkManagerWifi => {
  switch (backend) {
    case WifiBackend.NetworkManager:
      return watchNetworkManagerWifi;
    case WifiBackend.Iwd:
      return watchIwdWifi;
  }
};

/** The first backend whose service has an owner on the bus, if any. */
const detect = async (
  domicile: WifiDesktop,
  backends: readonly (readonly [string, WifiBackend])[],
): Promise<Result<Option<WifiBackend>, SystemError>> => {
  const [first, ...rest] = backends;
  if (first === undefined) {
    return Ok(None());
  } else {
    const [name, backend] = first;
    const owned = await hasOwner(domicile, name);
    return owned.match({
      Err: (error) => Promise.resolve(Err(error)),
      Ok: (has) =>
        has ? Promise.resolve(Ok(Some(backend))) : detect(domicile, rest),
    });
  }
};
