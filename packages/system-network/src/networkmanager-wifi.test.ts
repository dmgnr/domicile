import { describe, expect, it } from "bun:test";
import type { Option } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";
import type { DbusBody, SystemError } from "@domicile-desktop/sdk/system";
import { Bus, SystemErrorKind } from "@domicile-desktop/sdk/system";

import type { Replies } from "./fake-bus";
import {
  byKey,
  DONE,
  fakeBus,
  propertiesChanged,
  reports,
  SERVICE_UNKNOWN,
} from "./fake-bus";
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
  WifiConnection,
  WifiNetwork,
} from "./wifi-state";
import { WifiBackend, WifiSecurity } from "./wifi-state";

const NM = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const WIRED = `${ROOT}/Devices/1`;
const WIRELESS = `${ROOT}/Devices/3`;
const HOME = `${ROOT}/AccessPoint/12`;
const HOME_FAR = `${ROOT}/AccessPoint/13`;
const CAFE = `${ROOT}/AccessPoint/14`;
const HIDDEN = `${ROOT}/AccessPoint/15`;
const SETTINGS = `${ROOT}/Settings`;
const PROFILE = `${SETTINGS}/4`;
const OFFICE_PROFILE = `${SETTINGS}/5`;
const LIBRARY_PROFILE = `${SETTINGS}/6`;
const WIRED_PROFILE = `${SETTINGS}/7`;
const HOTSPOT_PROFILE = `${SETTINGS}/8`;
/** When Home was last joined, in seconds. */
const HOME_JOINED = 1_763_500_000;
const IP4 = `${ROOT}/IP4Config/7`;

const bytes = (text: string) => [...new TextEncoder().encode(text)];

const all = (properties: Record<string, unknown>): DbusBody => ({
  body: [properties],
  signature: "a{sv}",
});

const accessPoint = (ssid: string, strength: number, rsn: number): DbusBody =>
  all({
    Flags: { signature: "u", value: rsn === 0 ? 0 : 1 },
    Frequency: { signature: "u", value: 5180 },
    RsnFlags: { signature: "u", value: rsn },
    Ssid: { signature: "ay", value: bytes(ssid) },
    Strength: { signature: "y", value: strength },
    WpaFlags: { signature: "u", value: 0 },
  });

const settings = (sections: Record<string, unknown>): DbusBody => ({
  body: [sections],
  signature: "a{sa{sv}}",
});

const HOME_SECTIONS = {
  "802-11-wireless": {
    mode: { signature: "s", value: "infrastructure" },
    ssid: { signature: "ay", value: bytes("Home") },
  },
  "802-11-wireless-security": {
    "key-mgmt": { signature: "s", value: "sae" },
  },
  connection: {
    id: { signature: "s", value: "Home" },
    timestamp: { signature: "t", value: HOME_JOINED },
  },
};

const HOME_SETTINGS = settings(HOME_SECTIONS);

/** NetworkManager's replies, trimmed, for a laptop on its home Wi-Fi. */
const recorded = (enabled: boolean, active: string): Replies =>
  new Map([
    [
      `${ROOT} GetAll ${NM}`,
      Ok(all({ WirelessEnabled: { signature: "b", value: enabled } })),
    ],
    [`${ROOT} GetDevices`, Ok({ body: [[WIRED, WIRELESS]], signature: "ao" })],
    [
      `${WIRED} GetAll ${NM}.Device`,
      Ok(
        all({
          AvailableConnections: { signature: "ao", value: [] },
          DeviceType: { signature: "u", value: 1 },
          HwAddress: { signature: "s", value: "52:54:00:12:34:56" },
          Interface: { signature: "s", value: "enp0s31f6" },
          Ip4Config: { signature: "o", value: "/" },
        }),
      ),
    ],
    [
      `${WIRELESS} GetAll ${NM}.Device`,
      Ok(
        all({
          AvailableConnections: { signature: "ao", value: [PROFILE] },
          DeviceType: { signature: "u", value: 2 },
          HwAddress: { signature: "s", value: "A4:C3:F0:85:AC:2D" },
          Interface: { signature: "s", value: "wlan0" },
          Ip4Config: {
            signature: "o",
            value: active === "/" ? "/" : IP4,
          },
        }),
      ),
    ],
    [
      `${WIRELESS} GetAll ${NM}.Device.Wireless`,
      Ok(
        all({
          AccessPoints: {
            signature: "ao",
            value: [HOME_FAR, CAFE, HOME, HIDDEN],
          },
          ActiveAccessPoint: { signature: "o", value: active },
          Bitrate: { signature: "u", value: 866_700 },
        }),
      ),
    ],
    [`${HOME} GetAll ${NM}.AccessPoint`, Ok(accessPoint("Home", 72, 0x1_88))],
    [
      `${HOME_FAR} GetAll ${NM}.AccessPoint`,
      Ok(accessPoint("Home", 30, 0x1_88)),
    ],
    [`${CAFE} GetAll ${NM}.AccessPoint`, Ok(accessPoint("Cafe", 55, 0))],
    [`${HIDDEN} GetAll ${NM}.AccessPoint`, Ok(accessPoint("", 90, 0x1_88))],
    [
      `${SETTINGS} ListConnections`,
      Ok({
        body: [
          [
            PROFILE,
            WIRED_PROFILE,
            OFFICE_PROFILE,
            HOTSPOT_PROFILE,
            LIBRARY_PROFILE,
          ],
        ],
        signature: "ao",
      }),
    ],
    [`${PROFILE} GetSettings`, Ok(HOME_SETTINGS)],
    [
      `${OFFICE_PROFILE} GetSettings`,
      Ok(
        settings({
          "802-11-wireless": {
            ssid: { signature: "ay", value: bytes("Office") },
          },
          "802-11-wireless-security": {
            "key-mgmt": { signature: "s", value: "wpa-eap" },
          },
          connection: {
            autoconnect: { signature: "b", value: false },
            id: { signature: "s", value: "Office" },
          },
        }),
      ),
    ],
    [
      `${LIBRARY_PROFILE} GetSettings`,
      Ok(
        settings({
          "802-11-wireless": {
            ssid: { signature: "ay", value: bytes("Library") },
          },
          connection: {
            id: { signature: "s", value: "Library" },
            timestamp: { signature: "t", value: 0 },
          },
        }),
      ),
    ],
    [
      `${WIRED_PROFILE} GetSettings`,
      Ok(
        settings({
          "802-3-ethernet": {},
          connection: { id: { signature: "s", value: "Wired connection 1" } },
        }),
      ),
    ],
    [
      `${HOTSPOT_PROFILE} GetSettings`,
      Ok(
        settings({
          "802-11-wireless": {
            mode: { signature: "s", value: "ap" },
            ssid: { signature: "ay", value: bytes("Hotspot") },
          },
          connection: { id: { signature: "s", value: "Hotspot" } },
        }),
      ),
    ],
    [
      `${IP4} GetAll ${NM}.IP4Config`,
      Ok(
        all({
          AddressData: {
            signature: "aa{sv}",
            value: [
              {
                address: { signature: "s", value: "192.168.1.23" },
                prefix: { signature: "u", value: 24 },
              },
            ],
          },
          Gateway: { signature: "s", value: "192.168.1.1" },
          NameserverData: {
            signature: "aa{sv}",
            value: [{ address: { signature: "s", value: "192.168.1.1" } }],
          },
        }),
      ),
    ],
  ]);

const home: WifiNetwork = {
  connected: true,
  path: HOME,
  profile: PROFILE,
  secured: true,
  ssid: "Home",
  strength: 0.72,
};

const cafe: WifiNetwork = {
  connected: false,
  path: CAFE,
  profile: undefined,
  secured: false,
  ssid: "Cafe",
  strength: 0.55,
};

const CONNECTION: WifiConnection = {
  bitrate: 866.7,
  frequency: 5180,
  ip: {
    addresses: ["192.168.1.23/24"],
    dns: ["192.168.1.1"],
    gateway: "192.168.1.1",
  },
  ssid: "Home",
  strength: 0.72,
};

const SAVED: SavedWifi[] = [
  {
    autoJoin: true,
    lastUsed: new Date(HOME_JOINED * 1000),
    profile: PROFILE,
    security: WifiSecurity.Password,
    ssid: "Home",
  },
  {
    autoJoin: false,
    lastUsed: undefined,
    profile: OFFICE_PROFILE,
    security: WifiSecurity.Enterprise,
    ssid: "Office",
  },
  {
    autoJoin: true,
    lastUsed: undefined,
    profile: LIBRARY_PROFILE,
    security: WifiSecurity.Open,
    ssid: "Library",
  },
];

const [savedHome] = SAVED as [SavedWifi];

const CONNECTED: Wifi = {
  backend: WifiBackend.NetworkManager,
  connection: CONNECTION,
  device: WIRELESS,
  enabled: true,
  hardwareAddress: "A4:C3:F0:85:AC:2D",
  interface: "wlan0",
  networks: [home, cafe],
  saved: SAVED,
  scanning: false,
};

describe("watchNetworkManagerWifi", () => {
  it("reads the Wi-Fi device, its networks and its connection", async () => {
    const bus = fakeBus(byKey(recorded(true, HOME)));
    const seen = reports<Option<Wifi>>();

    watchNetworkManagerWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
    expect(bus.matches).toStrictEqual([{ bus: Bus.System, sender: NM }]);
  });

  it("reads no connection while disconnected", async () => {
    const bus = fakeBus(byKey(recorded(true, "/")));
    const seen = reports<Option<Wifi>>();

    watchNetworkManagerWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(
      Ok(
        Some({
          ...CONNECTED,
          connection: undefined,
          networks: [{ ...home, connected: false }, cafe],
        }),
      ),
    );
  });

  it("reads no gateway when NetworkManager has none", async () => {
    const replies = recorded(true, HOME);
    replies.set(
      `${IP4} GetAll ${NM}.IP4Config`,
      Ok(
        all({
          AddressData: { signature: "aa{sv}", value: [] },
          Gateway: { signature: "s", value: "" },
          NameserverData: { signature: "aa{sv}", value: [] },
        }),
      ),
    );
    const bus = fakeBus(byKey(replies));
    const seen = reports<Option<Wifi>>();

    watchNetworkManagerWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(
      Ok(
        Some({
          ...CONNECTED,
          connection: {
            ...CONNECTION,
            ip: { addresses: [], dns: [], gateway: undefined },
          },
        }),
      ),
    );
  });

  it("reads nothing without a Wi-Fi device", async () => {
    const replies = recorded(true, "/");
    replies.set(`${ROOT} GetDevices`, Ok({ body: [[WIRED]], signature: "ao" }));
    const bus = fakeBus(byKey(replies));
    const seen = reports<Option<Wifi>>();

    watchNetworkManagerWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Ok(None()));
  });

  it("reports the error when NetworkManager is not running", async () => {
    const replies = recorded(true, HOME);
    replies.set(`${ROOT} GetAll ${NM}`, Err(SERVICE_UNKNOWN));
    const bus = fakeBus(byKey(replies));
    const seen = reports<Option<Wifi>>();

    watchNetworkManagerWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Err(SERVICE_UNKNOWN));
  });

  describe("changes", () => {
    it("reads again when an object it read changes", async () => {
      const replies = recorded(true, HOME);
      const bus = fakeBus(byKey(replies));
      const seen = reports<Option<Wifi>>();
      watchNetworkManagerWifi(bus.domicile, seen.on);
      await seen.next();

      replies.set(
        `${ROOT} GetAll ${NM}`,
        Ok(all({ WirelessEnabled: { signature: "b", value: false } })),
      );
      await bus.send(
        propertiesChanged(`${ROOT}/Devices/9`, `${NM}.Device`, {
          State: { signature: "u", value: 100 },
        }),
      );
      await bus.send(
        propertiesChanged(ROOT, NM, {
          WirelessEnabled: { signature: "b", value: false },
        }),
      );

      expect(await seen.next()).toStrictEqual(
        Ok(Some({ ...CONNECTED, enabled: false })),
      );
      expect(seen.pending).toBe(0);
    });

    it("reads again when a saved profile comes, goes or changes", async () => {
      const bus = fakeBus(byKey(recorded(true, HOME)));
      const seen = reports<Option<Wifi>>();
      watchNetworkManagerWifi(bus.domicile, seen.on);
      await seen.next();

      for (const [path, iface, member] of [
        [SETTINGS, `${NM}.Settings`, "NewConnection"],
        [SETTINGS, `${NM}.Settings`, "ConnectionRemoved"],
        [OFFICE_PROFILE, `${NM}.Settings.Connection`, "Updated"],
      ] as const) {
        await bus.send({
          body: member === "Updated" ? [] : [`${SETTINGS}/9`],
          interface: iface,
          member,
          path,
          sender: ":1.7",
          signature: member === "Updated" ? "" : "o",
        });

        expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
      }
    });

    it("reads again when an access point comes", async () => {
      const bus = fakeBus(byKey(recorded(true, HOME)));
      const seen = reports<Option<Wifi>>();
      watchNetworkManagerWifi(bus.domicile, seen.on);
      await seen.next();

      await bus.send({
        body: [`${ROOT}/AccessPoint/20`],
        interface: `${NM}.Device.Wireless`,
        member: "AccessPointAdded",
        path: WIRELESS,
        sender: ":1.7",
        signature: "o",
      });

      expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
    });
  });
});

describe("NetworkManager Wi-Fi requests", () => {
  const request = (
    path: string,
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
  ) => ({
    body,
    bus: Bus.System,
    destination: NM,
    interface: iface,
    member,
    path,
    signature,
  });

  it("turns Wi-Fi off", async () => {
    const bus = fakeBus(() => Ok(DONE));

    expect(
      await setNetworkManagerWifiEnabled(bus.domicile, CONNECTED, false),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      request(ROOT, "org.freedesktop.DBus.Properties", "Set", "ssv", [
        NM,
        "WirelessEnabled",
        { signature: "b", value: false },
      ]),
    ]);
  });

  it("scans", async () => {
    const bus = fakeBus(() => Ok(DONE));

    expect(await scanNetworkManagerWifi(bus.domicile, CONNECTED)).toStrictEqual(
      Ok("done"),
    );
    expect(bus.calls).toStrictEqual([
      request(WIRELESS, `${NM}.Device.Wireless`, "RequestScan", "a{sv}", [{}]),
    ]);
  });

  it("disconnects the device", async () => {
    const bus = fakeBus(() => Ok(DONE));

    expect(
      await disconnectNetworkManagerWifi(bus.domicile, CONNECTED),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      {
        bus: Bus.System,
        destination: NM,
        interface: `${NM}.Device`,
        member: "Disconnect",
        path: WIRELESS,
      },
    ]);
  });

  it("forgets a saved network by deleting its profile", async () => {
    const bus = fakeBus(() => Ok(DONE));

    expect(
      await forgetNetworkManagerWifi(bus.domicile, CONNECTED, savedHome),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      {
        bus: Bus.System,
        destination: NM,
        interface: `${NM}.Settings.Connection`,
        member: "Delete",
        path: PROFILE,
      },
    ]);
  });

  describe("joining automatically", () => {
    it("writes the profile back with autoconnect changed and the rest as read", async () => {
      const replies = recorded(true, HOME);
      replies.set(`${PROFILE} Update`, Ok(DONE));
      const bus = fakeBus(byKey(replies));

      expect(
        await setNetworkManagerWifiAutoJoin(
          bus.domicile,
          CONNECTED,
          savedHome,
          false,
        ),
      ).toStrictEqual(Ok("done"));
      expect(bus.calls.at(-1)).toStrictEqual(
        request(PROFILE, `${NM}.Settings.Connection`, "Update", "a{sa{sv}}", [
          {
            ...HOME_SECTIONS,
            connection: {
              autoconnect: { signature: "b", value: false },
              id: { signature: "s", value: "Home" },
              timestamp: { signature: "t", value: HOME_JOINED },
            },
          },
        ]),
      );
    });

    it("reports a failure to read the profile, and writes nothing", async () => {
      const replies = recorded(true, HOME);
      replies.set(`${PROFILE} GetSettings`, Err(SERVICE_UNKNOWN));
      const bus = fakeBus(byKey(replies));

      expect(
        await setNetworkManagerWifiAutoJoin(
          bus.domicile,
          CONNECTED,
          savedHome,
          true,
        ),
      ).toStrictEqual(Err(SERVICE_UNKNOWN));
      expect(bus.calls.map(({ member }) => member)).toStrictEqual([
        "GetSettings",
      ]);
    });
  });

  describe("connecting", () => {
    it("activates a network's saved profile", async () => {
      const bus = fakeBus(() =>
        Ok({ body: [`${ROOT}/ActiveConnection/5`], signature: "o" }),
      );

      expect(
        await connectNetworkManagerWifi(
          bus.domicile,
          CONNECTED,
          home,
          undefined,
        ),
      ).toStrictEqual(Ok("done"));
      expect(bus.calls).toStrictEqual([
        request(ROOT, NM, "ActivateConnection", "ooo", [
          PROFILE,
          WIRELESS,
          HOME,
        ]),
      ]);
    });

    it("adds a profile for an open network", async () => {
      const bus = fakeBus(() => Ok(DONE));

      await connectNetworkManagerWifi(bus.domicile, CONNECTED, cafe, undefined);

      expect(bus.calls).toStrictEqual([
        request(ROOT, NM, "AddAndActivateConnection", "a{sa{sv}}oo", [
          {},
          WIRELESS,
          CAFE,
        ]),
      ]);
    });

    it("adds a profile with the passphrase for a secured network", async () => {
      const bus = fakeBus(() => Ok(DONE));

      await connectNetworkManagerWifi(
        bus.domicile,
        CONNECTED,
        { ...home, profile: undefined },
        "hunter22",
      );

      expect(bus.calls).toStrictEqual([
        request(ROOT, NM, "AddAndActivateConnection", "a{sa{sv}}oo", [
          {
            "802-11-wireless-security": {
              "key-mgmt": { signature: "s", value: "wpa-psk" },
              psk: { signature: "s", value: "hunter22" },
            },
          },
          WIRELESS,
          HOME,
        ]),
      ]);
    });

    it("reports NetworkManager's refusal", async () => {
      const refused: SystemError = {
        kind: SystemErrorKind.Dbus,
        message:
          "org.freedesktop.NetworkManager.Device.NoSecrets: No secrets were provided",
      };
      const bus = fakeBus(() => Err(refused));

      expect(
        await connectNetworkManagerWifi(
          bus.domicile,
          CONNECTED,
          home,
          undefined,
        ),
      ).toStrictEqual(Err(refused));
    });

    it("throws for a new secured network with no passphrase", () => {
      const bus = fakeBus(() => Ok(DONE));

      expect(
        connectNetworkManagerWifi(
          bus.domicile,
          CONNECTED,
          { ...home, profile: undefined },
          undefined,
        ),
      ).rejects.toThrow("needs a passphrase");
    });
  });
});
