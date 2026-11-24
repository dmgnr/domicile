// NetworkManager's Wi-Fi device over the system bus: its networks and
// connection, kept current, and the requests that change them. See
// docs/SHELL-SYSTEM-ACCESS.md.

import type { Option } from "@cprussin/option-result";
import { None, Ok, Result, Some } from "@cprussin/option-result";
import type {
  DbusCall,
  DbusSignal,
  SystemError,
} from "@domicile-desktop/sdk/system";
import { Bus } from "@domicile-desktop/sdk/system";
import { z } from "zod";

import type { Reading } from "./follow";
import { followBus } from "./follow";
import type { NetworkDesktop } from "./network-state";
import { variant } from "./variant";
import type {
  Ip,
  SavedWifi,
  Wifi,
  WifiConnection,
  WifiDevice,
  WifiNetwork,
} from "./wifi-state";
import { WifiBackend, WifiSecurity } from "./wifi-state";

const SERVICE = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const DEVICE = `${SERVICE}.Device`;
const WIRELESS = `${SERVICE}.Device.Wireless`;
const SETTINGS = `${ROOT}/Settings`;
const PROFILE = `${SERVICE}.Settings.Connection`;
/** The object path NetworkManager uses for "none". */
const NO_OBJECT = "/";
/** `NM_DEVICE_TYPE_WIFI`. */
const WIFI_DEVICE = 2;

/** A read's outcome: Wi-Fi, if there is a device, or the first failure. */
type Found = Result<Option<Wifi>, SystemError>;

/**
 * Calls `onWifi` with the first Wi-Fi device now and after each change, and
 * returns a function that stops watching. `None` is a machine without one.
 *
 * An `Err` is a D-Bus failure, such as NetworkManager not running. The watch
 * keeps listening after one, so a later change reads again.
 */
export const watchNetworkManagerWifi = (
  domicile: NetworkDesktop,
  onWifi: (wifi: Found) => void,
): (() => void) =>
  followBus(
    domicile,
    { bus: Bus.System, sender: SERVICE },
    () => read(domicile),
    onWifi,
  );

/** Turn the Wi-Fi radio on or off. */
export const setNetworkManagerWifiEnabled = async (
  domicile: NetworkDesktop,
  _wifi: WifiDevice,
  enabled: boolean,
): Promise<Result<"done", SystemError>> =>
  done(
    await domicile.dbus.call(
      request(ROOT, "org.freedesktop.DBus.Properties", "Set", "ssv", [
        SERVICE,
        "WirelessEnabled",
        { signature: "b", value: enabled },
      ]),
    ),
  );

/** Ask for a scan. Networks it finds arrive as changes. */
export const scanNetworkManagerWifi = async (
  domicile: NetworkDesktop,
  wifi: WifiDevice,
): Promise<Result<"done", SystemError>> =>
  done(
    await domicile.dbus.call(
      request(wifi.device, WIRELESS, "RequestScan", "a{sv}", [{}]),
    ),
  );

/**
 * Join `network`: through its saved profile if it has one, or with a new
 * profile, which needs `passphrase` when the network is secured.
 */
export const connectNetworkManagerWifi = async (
  domicile: NetworkDesktop,
  wifi: WifiDevice,
  network: WifiNetwork,
  passphrase: string | undefined,
): Promise<Result<"done", SystemError>> =>
  done(
    await domicile.dbus.call(
      network.profile === undefined
        ? request(ROOT, SERVICE, "AddAndActivateConnection", "a{sa{sv}}oo", [
            newProfile(network, passphrase),
            wifi.device,
            network.path,
          ])
        : request(ROOT, SERVICE, "ActivateConnection", "ooo", [
            network.profile,
            wifi.device,
            network.path,
          ]),
    ),
  );

/** Leave the current network, until asked to join one. */
export const disconnectNetworkManagerWifi = async (
  domicile: NetworkDesktop,
  wifi: WifiDevice,
): Promise<Result<"done", SystemError>> =>
  done(
    await domicile.dbus.call({
      bus: Bus.System,
      destination: SERVICE,
      interface: DEVICE,
      member: "Disconnect",
      path: wifi.device,
    }),
  );

/** Forget a saved network: delete its profile. */
export const forgetNetworkManagerWifi = async (
  domicile: NetworkDesktop,
  _wifi: WifiDevice,
  saved: SavedWifi,
): Promise<Result<"done", SystemError>> =>
  done(await call(domicile, saved.profile, PROFILE, "Delete"));

/**
 * Whether NetworkManager joins a saved network by itself. Writes the profile
 * back as read with `connection.autoconnect` changed; NetworkManager keeps
 * the secrets, which a read leaves out.
 */
export const setNetworkManagerWifiAutoJoin = async (
  domicile: NetworkDesktop,
  _wifi: WifiDevice,
  saved: SavedWifi,
  autoJoin: boolean,
): Promise<Result<"done", SystemError>> =>
  (await call(domicile, saved.profile, PROFILE, "GetSettings")).andThenAsync(
    async ({ body }) => {
      const [{ connection, ...sections }] = rawSettingsSchema.parse(body);
      return done(
        await domicile.dbus.call(
          request(saved.profile, PROFILE, "Update", "a{sa{sv}}", [
            {
              ...sections,
              connection: {
                ...connection,
                autoconnect: { signature: "b", value: autoJoin },
              },
            },
          ]),
        ),
      );
    },
  );

const request = (
  path: string,
  iface: string,
  member: string,
  signature: string,
  body: unknown[],
): DbusCall => ({
  body,
  bus: Bus.System,
  destination: SERVICE,
  interface: iface,
  member,
  path,
  signature,
});

const done = <T extends NonNullable<unknown>>(
  reply: Result<T, SystemError>,
): Result<"done", SystemError> => reply.map(() => "done");

/** The settings NetworkManager fills in a profile from, past the access point. */
const newProfile = (
  network: WifiNetwork,
  passphrase: string | undefined,
): Record<string, Record<string, { signature: string; value: string }>> => {
  if (!network.secured) {
    return {};
  } else if (passphrase === undefined) {
    throw new Error(`joining ${network.ssid} needs a passphrase`);
  } else {
    return {
      "802-11-wireless-security": {
        "key-mgmt": { signature: "s", value: "wpa-psk" },
        psk: { signature: "s", value: passphrase },
      },
    };
  }
};

/**
 * Read Wi-Fi. A property change on an object read for it matters, as does an
 * access point or a device coming or going.
 */
const read = async (
  domicile: NetworkDesktop,
): Promise<Reading<Option<Wifi>>> => {
  const paths = new Set([ROOT]);
  const value = await readWifi(domicile, paths);
  return { matters: (signal) => matters(paths, signal), value };
};

const matters = (paths: ReadonlySet<string>, signal: DbusSignal): boolean => {
  switch (signal.member) {
    case "AccessPointAdded":
    case "AccessPointRemoved":
    case "ConnectionRemoved":
    case "DeviceAdded":
    case "DeviceRemoved":
    case "NewConnection":
    case "Updated": {
      return true;
    }
    case "PropertiesChanged": {
      return (
        signal.interface === "org.freedesktop.DBus.Properties" &&
        paths.has(signal.path)
      );
    }
    default: {
      return false;
    }
  }
};

/** Read Wi-Fi, adding each object read to `paths`. */
const readWifi = async (
  domicile: NetworkDesktop,
  paths: Set<string>,
): Promise<Found> =>
  (await properties(domicile, ROOT, SERVICE, rootSchema)).andThenAsync(
    async ({ WirelessEnabled: enabled }) =>
      (await call(domicile, ROOT, SERVICE, "GetDevices")).andThenAsync(
        async ({ body }) => {
          const listed = pathsSchema.parse(body)[0];
          for (const path of listed) {
            paths.add(path);
          }
          const devices = Result.collect(
            await Promise.all(
              listed.map(async (path) =>
                (await properties(domicile, path, DEVICE, deviceSchema)).map(
                  (device) => ({ device, path }),
                ),
              ),
            ),
          );
          return devices.andThenAsync(async (read) => {
            const found = read.find(
              ({ device }) => device.DeviceType === WIFI_DEVICE,
            );
            return found === undefined
              ? Ok<Option<Wifi>, SystemError>(None())
              : (
                  await wifiOf(
                    domicile,
                    paths,
                    found.path,
                    found.device,
                    enabled,
                  )
                ).map((wifi) => Some(wifi));
          });
        },
      ),
  );

/** The Wi-Fi device at `path`. */
const wifiOf = async (
  domicile: NetworkDesktop,
  paths: Set<string>,
  path: string,
  device: Device,
  enabled: boolean,
): Promise<Result<Wifi, SystemError>> =>
  (await properties(domicile, path, WIRELESS, wirelessSchema)).andThenAsync(
    async (radio) => {
      for (const point of radio.AccessPoints) {
        paths.add(point);
      }
      paths.add(device.Ip4Config);
      const [points, profiles, ip] = await Promise.all([
        accessPoints(domicile, radio.AccessPoints),
        savedProfiles(domicile),
        radio.ActiveAccessPoint === NO_OBJECT || device.Ip4Config === NO_OBJECT
          ? Promise.resolve(Ok<Option<Ip>, SystemError>(None()))
          : ipOf(domicile, device.Ip4Config),
      ]);
      return points.andThen((read) =>
        profiles.andThen((saved) =>
          ip.map((address) => ({
            backend: WifiBackend.NetworkManager,
            connection: connectionOf(read, radio, address),
            device: path,
            enabled,
            hardwareAddress: device.HwAddress,
            interface: device.Interface,
            networks: networksOf(
              read,
              availableOf(saved, device.AvailableConnections),
              radio.ActiveAccessPoint,
            ),
            saved,
            scanning: false,
          })),
        ),
      );
    },
  );

/** An access point, by its path. */
type Point = AccessPoint & { path: string };

const accessPoints = async (
  domicile: NetworkDesktop,
  listed: readonly string[],
): Promise<Result<Point[], SystemError>> =>
  Result.collect(
    await Promise.all(
      listed.map(async (path) =>
        (
          await properties(
            domicile,
            path,
            `${SERVICE}.AccessPoint`,
            accessPointSchema,
          )
        ).map((point) => ({ ...point, path })),
      ),
    ),
  );

/** Every saved Wi-Fi profile, leaving out hotspots this machine serves. */
const savedProfiles = async (
  domicile: NetworkDesktop,
): Promise<Result<SavedWifi[], SystemError>> =>
  (
    await call(domicile, SETTINGS, `${SERVICE}.Settings`, "ListConnections")
  ).andThenAsync(async ({ body }) =>
    Result.collect(
      await Promise.all(
        pathsSchema
          .parse(body)[0]
          .map(async (path) =>
            (await call(domicile, path, PROFILE, "GetSettings")).map(
              ({ body: read }) => savedOf(path, settingsSchema.parse(read)[0]),
            ),
          ),
      ),
    ).map((saved) => saved.flatMap((found) => found)),
  );

/** A profile as a saved network, or nothing for one that isn't Wi-Fi. */
const savedOf = (path: string, settings: Settings): SavedWifi[] => {
  const wireless = settings["802-11-wireless"];
  const timestamp = settings.connection.timestamp;
  return wireless?.ssid === undefined || wireless.mode === "ap"
    ? []
    : [
        {
          autoJoin: settings.connection.autoconnect ?? true,
          lastUsed:
            timestamp === undefined || timestamp === 0
              ? undefined
              : new Date(timestamp * 1000),
          profile: path,
          security: securityOf(settings["802-11-wireless-security"]),
          ssid: wireless.ssid,
        },
      ];
};

/** What a profile's `key-mgmt` asks of a person; no security section is open. */
const securityOf = (
  security: Settings["802-11-wireless-security"],
): WifiSecurity => {
  const keyManagement = security?.["key-mgmt"];
  switch (keyManagement) {
    case undefined:
    case "owe": {
      return WifiSecurity.Open;
    }
    case "none":
    case "sae":
    case "wpa-psk": {
      return WifiSecurity.Password;
    }
    case "ieee8021x":
    case "wpa-eap":
    case "wpa-eap-suite-b-192": {
      return WifiSecurity.Enterprise;
    }
    default: {
      throw new Error(`NetworkManager key-mgmt ${keyManagement} is unknown`);
    }
  }
};

/** The device's usable profiles' paths, by their network's name. */
const availableOf = (
  saved: readonly SavedWifi[],
  available: readonly string[],
): Map<string, string> =>
  new Map(
    saved
      .filter(({ profile }) => available.includes(profile))
      .map(({ profile, ssid: name }) => [name, profile] as const),
  );

const ipOf = async (
  domicile: NetworkDesktop,
  path: string,
): Promise<Result<Option<Ip>, SystemError>> =>
  (await properties(domicile, path, `${SERVICE}.IP4Config`, ip4Schema)).map(
    (config) =>
      Some({
        addresses: config.AddressData.map(
          ({ address, prefix }) => `${address}/${prefix}`,
        ),
        dns: config.NameserverData.map(({ address }) => address),
        gateway: config.Gateway === "" ? undefined : config.Gateway,
      }),
  );

/** The named networks, one per name: its strongest access point. */
const networksOf = (
  points: readonly Point[],
  profiles: ReadonlyMap<string, string>,
  active: string,
): WifiNetwork[] => {
  const byName = new Map<string, Point[]>();
  for (const point of points.filter(({ Ssid }) => Ssid !== "")) {
    byName.set(point.Ssid, [...(byName.get(point.Ssid) ?? []), point]);
  }
  return [...byName.values()]
    .map((named) => {
      const [strongest] = named.toSorted((a, b) => b.Strength - a.Strength);
      if (strongest === undefined) {
        throw new Error("a network with no access point");
      } else {
        return {
          connected: named.some(({ path }) => path === active),
          path: strongest.path,
          profile: profiles.get(strongest.Ssid),
          secured: isSecured(strongest),
          ssid: strongest.Ssid,
          strength: strongest.Strength / 100,
        };
      }
    })
    .toSorted((a, b) => b.strength - a.strength);
};

const connectionOf = (
  points: readonly Point[],
  radio: Wireless,
  ip: Option<Ip>,
): WifiConnection | undefined => {
  const active = points.find(({ path }) => path === radio.ActiveAccessPoint);
  return active === undefined
    ? undefined
    : {
        bitrate: radio.Bitrate / 1000,
        frequency: active.Frequency,
        ip: ip.match({ None: () => undefined, Some: (address) => address }),
        ssid: active.Ssid,
        strength: active.Strength / 100,
      };
};

/** `NM_802_11_AP_FLAGS_PRIVACY`, or any WPA or RSN flag. */
const isSecured = (point: AccessPoint): boolean =>
  (point.Flags & 1) !== 0 || point.WpaFlags !== 0 || point.RsnFlags !== 0;

const call = (
  domicile: NetworkDesktop,
  path: string,
  iface: string,
  member: string,
) =>
  domicile.dbus.call({
    bus: Bus.System,
    destination: SERVICE,
    interface: iface,
    member,
    path,
  });

/** `Properties.GetAll` on one of NetworkManager's objects, parsed. */
const properties = async <T extends NonNullable<unknown>>(
  domicile: NetworkDesktop,
  path: string,
  interfaceName: string,
  schema: z.ZodType<T>,
): Promise<Result<T, SystemError>> =>
  (
    await domicile.dbus.call({
      body: [interfaceName],
      bus: Bus.System,
      destination: SERVICE,
      interface: "org.freedesktop.DBus.Properties",
      member: "GetAll",
      path,
      signature: "s",
    })
  ).map(({ body }) => z.tuple([schema]).parse(body)[0]);

/** An SSID's bytes, as text. */
const ssid = z
  .array(z.number())
  .transform((bytes) => new TextDecoder().decode(new Uint8Array(bytes)));

const rootSchema = z.object({ WirelessEnabled: variant(z.boolean()) });

/** An `ao` reply: devices, or profiles. */
const pathsSchema = z.tuple([z.array(z.string())]);

const deviceSchema = z.object({
  AvailableConnections: variant(z.array(z.string())),
  DeviceType: variant(z.number()),
  HwAddress: variant(z.string()),
  Interface: variant(z.string()),
  Ip4Config: variant(z.string()),
});

type Device = z.infer<typeof deviceSchema>;

const wirelessSchema = z.object({
  AccessPoints: variant(z.array(z.string())),
  ActiveAccessPoint: variant(z.string()),
  /** In kbit/s. */
  Bitrate: variant(z.number()),
});

type Wireless = z.infer<typeof wirelessSchema>;

const accessPointSchema = z.object({
  Flags: variant(z.number()),
  Frequency: variant(z.number()),
  RsnFlags: variant(z.number()),
  Ssid: variant(ssid),
  Strength: variant(z.number()),
  WpaFlags: variant(z.number()),
});

type AccessPoint = z.infer<typeof accessPointSchema>;

/** `autoconnect` is left out at its default, `true`; `timestamp` at `0`, never. */
const settingsSchema = z.tuple([
  z.object({
    "802-11-wireless": z
      .object({
        mode: variant(z.string()).optional(),
        ssid: variant(ssid).optional(),
      })
      .optional(),
    "802-11-wireless-security": z
      .object({ "key-mgmt": variant(z.string()) })
      .optional(),
    connection: z.object({
      autoconnect: variant(z.boolean()).optional(),
      timestamp: variant(z.number()).optional(),
    }),
  }),
]);

type Settings = z.infer<typeof settingsSchema>[0];

/** A profile's settings as read, to write back. */
const rawSettingsSchema = z.tuple([
  z.record(z.string(), z.record(z.string(), z.unknown())),
]);

const ip4Schema = z.object({
  AddressData: variant(
    z.array(
      z.object({
        address: variant(z.string()),
        prefix: variant(z.number()),
      }),
    ),
  ),
  Gateway: variant(z.string()),
  NameserverData: variant(z.array(z.object({ address: variant(z.string()) }))),
});
