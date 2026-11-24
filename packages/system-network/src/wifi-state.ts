// The Wi-Fi device as every backend reports it: its networks and its
// connection. See docs/SHELL-SYSTEM-ACCESS.md.

import type { Dbus } from "@domicile-desktop/sdk/desktop/dbus";
import type { Processes } from "@domicile-desktop/sdk/desktop/processes";

/** The service that manages the Wi-Fi device. */
export enum WifiBackend {
  NetworkManager,
  Iwd,
}

/** A network in range. */
export type WifiNetwork = {
  /** The service's object for it: an access point (NetworkManager) or a network (iwd). */
  path: string;
  ssid: string;
  /** 0 through 1. */
  strength: number;
  secured: boolean;
  /** The saved profile: a connection (NetworkManager) or a known network (iwd). */
  profile: string | undefined;
  connected: boolean;
};

/** How a saved network asks to join. */
export enum WifiSecurity {
  Open,
  /** A shared password: WEP, WPA or WPA3 Personal. */
  Password,
  /** A sign-in per person: 802.1X, WPA Enterprise or Passpoint. */
  Enterprise,
}

/** A network the service remembers, in range or not. */
export type SavedWifi = {
  /** The profile: a connection (NetworkManager) or a known network (iwd). */
  profile: string;
  ssid: string;
  security: WifiSecurity;
  /** Whether the service joins it by itself when it is in range. */
  autoJoin: boolean;
  /** When it was last joined; `undefined` if never. */
  lastUsed: Date | undefined;
};

/** The addresses the service configured. */
export type Ip = {
  /** Each with its prefix, as `192.168.1.23/24`. */
  addresses: string[];
  gateway: string | undefined;
  dns: string[];
};

export type WifiConnection = {
  ssid: string;
  /** 0 through 1. */
  strength: number;
  /** In MHz. */
  frequency: number | undefined;
  /** In Mbit/s. */
  bitrate: number | undefined;
  /** `undefined` from iwd, which does not report addresses over D-Bus. */
  ip: Ip | undefined;
};

export type Wifi = {
  backend: WifiBackend;
  /** The device's object, which requests address. */
  device: string;
  interface: string;
  hardwareAddress: string;
  /** Whether the radio is on. */
  enabled: boolean;
  /** Whether a scan is running. Always `false` from NetworkManager, which does not say. */
  scanning: boolean;
  /** One per name, strongest first. Hidden networks are left out. */
  networks: WifiNetwork[];
  connection: WifiConnection | undefined;
  /** Every saved network, in the service's order. */
  saved: SavedWifi[];
};

/** What a request needs of the device. */
export type WifiDevice = Pick<Wifi, "backend" | "device" | "interface">;

/** The calls this library makes for Wi-Fi. */
export type WifiDesktop = {
  readonly dbus: Pick<Dbus, "call" | "match">;
  readonly processes: Pick<Processes, "run">;
};
