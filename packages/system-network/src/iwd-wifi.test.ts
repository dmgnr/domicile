import { describe, expect, it } from "bun:test";
import type { Option } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";
import type { DbusBody, Ran, SystemError } from "@domicile-desktop/sdk/system";
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
  connectIwdWifi,
  disconnectIwdWifi,
  forgetIwdWifi,
  scanIwdWifi,
  setIwdWifiAutoJoin,
  setIwdWifiEnabled,
  watchIwdWifi,
} from "./iwd-wifi";
import type { SavedWifi, Wifi, WifiNetwork } from "./wifi-state";
import { WifiBackend, WifiSecurity } from "./wifi-state";

const IWD = "net.connman.iwd";
const DEVICE = "/net/connman/iwd/0/4";
const HOME = `${DEVICE}/486f6d65_psk`;
const CAFE = `${DEVICE}/43616665_open`;
const KNOWN_HOME = "/net/connman/iwd/486f6d65_psk";
const KNOWN_OFFICE = "/net/connman/iwd/4f6666696365_8021x";
const KNOWN_LIBRARY = "/net/connman/iwd/4c696272617279_open";
const HOME_JOINED = "2025-11-18T21:46:40Z";

const v = (signature: string, value: unknown) => ({ signature, value });

/** `GetManagedObjects` as the compositor writes it, trimmed. */
const managed = (powered: boolean, diagnostics = true): DbusBody => ({
  body: [
    {
      "/net/connman/iwd": { [`${IWD}.AgentManager`]: {} },
      "/net/connman/iwd/0": {
        [`${IWD}.Adapter`]: { Powered: v("b", true) },
      },
      [DEVICE]: {
        [`${IWD}.Device`]: {
          Address: v("s", "a4:c3:f0:85:ac:2d"),
          Mode: v("s", "station"),
          Name: v("s", "wlan0"),
          Powered: v("b", powered),
        },
        ...(powered
          ? {
              [`${IWD}.Station`]: {
                ConnectedNetwork: v("o", HOME),
                Scanning: v("b", false),
                State: v("s", "connected"),
              },
              ...(diagnostics ? { [`${IWD}.StationDiagnostic`]: {} } : {}),
            }
          : {}),
      },
      ...(powered
        ? {
            [CAFE]: {
              [`${IWD}.Network`]: {
                Connected: v("b", false),
                Device: v("o", DEVICE),
                Name: v("s", "Cafe"),
                Type: v("s", "open"),
              },
            },
            [HOME]: {
              [`${IWD}.Network`]: {
                Connected: v("b", true),
                Device: v("o", DEVICE),
                KnownNetwork: v("o", KNOWN_HOME),
                Name: v("s", "Home"),
                Type: v("s", "psk"),
              },
            },
          }
        : {}),
      [KNOWN_HOME]: {
        [`${IWD}.KnownNetwork`]: {
          AutoConnect: v("b", true),
          Hidden: v("b", false),
          LastConnectedTime: v("s", HOME_JOINED),
          Name: v("s", "Home"),
          Type: v("s", "psk"),
        },
      },
      [KNOWN_OFFICE]: {
        [`${IWD}.KnownNetwork`]: {
          AutoConnect: v("b", false),
          Hidden: v("b", false),
          Name: v("s", "Office"),
          Type: v("s", "8021x"),
        },
      },
      [KNOWN_LIBRARY]: {
        [`${IWD}.KnownNetwork`]: {
          AutoConnect: v("b", true),
          Hidden: v("b", false),
          Name: v("s", "Library"),
          Type: v("s", "open"),
        },
      },
    },
  ],
  signature: "a{oa{sa{sv}}}",
});

const recorded = (powered: boolean): Replies =>
  new Map([
    ["/ GetManagedObjects", Ok(managed(powered))],
    [
      `${DEVICE} GetOrderedNetworks`,
      Ok({
        body: [
          [
            [HOME, -5600],
            [CAFE, -7000],
          ],
        ],
        signature: "a(on)",
      }),
    ],
    [
      `${DEVICE} GetDiagnostics`,
      Ok({
        body: [
          {
            ConnectedBss: v("s", "f0:9f:c2:10:20:30"),
            Frequency: v("u", 5180),
            RSSI: v("n", -56),
            RxBitrate: v("u", 8667),
            Security: v("s", "WPA2-Personal"),
          },
        ],
        signature: "a{sv}",
      }),
    ],
  ]);

const home: WifiNetwork = {
  connected: true,
  path: HOME,
  profile: KNOWN_HOME,
  secured: true,
  ssid: "Home",
  strength: 44 / 60,
};

const cafe: WifiNetwork = {
  connected: false,
  path: CAFE,
  profile: undefined,
  secured: false,
  ssid: "Cafe",
  strength: 0.5,
};

const SAVED: SavedWifi[] = [
  {
    autoJoin: true,
    lastUsed: new Date(HOME_JOINED),
    profile: KNOWN_HOME,
    security: WifiSecurity.Password,
    ssid: "Home",
  },
  {
    autoJoin: false,
    lastUsed: undefined,
    profile: KNOWN_OFFICE,
    security: WifiSecurity.Enterprise,
    ssid: "Office",
  },
  {
    autoJoin: true,
    lastUsed: undefined,
    profile: KNOWN_LIBRARY,
    security: WifiSecurity.Open,
    ssid: "Library",
  },
];

const [savedHome] = SAVED as [SavedWifi];

const CONNECTED: Wifi = {
  backend: WifiBackend.Iwd,
  connection: {
    bitrate: 866.7,
    frequency: 5180,
    ip: undefined,
    ssid: "Home",
    strength: 44 / 60,
  },
  device: DEVICE,
  enabled: true,
  hardwareAddress: "a4:c3:f0:85:ac:2d",
  interface: "wlan0",
  networks: [home, cafe],
  saved: SAVED,
  scanning: false,
};

/** Never called: requests over D-Bus run nothing. */
const NO_RUN = () => {
  throw new Error("test: nothing should run");
};

const iwdBus = (replies: Replies) => {
  const bus = fakeBus(byKey(replies));
  return { ...bus, domicile: { ...bus.domicile, processes: { run: NO_RUN } } };
};

describe("watchIwdWifi", () => {
  it("reads the station, its networks and its connection", async () => {
    const bus = iwdBus(recorded(true));
    const seen = reports<Option<Wifi>>();

    watchIwdWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
    expect(bus.matches).toStrictEqual([{ bus: Bus.System, sender: IWD }]);
  });

  it("reads no frequency or speed without iwd's diagnostics", async () => {
    const replies = recorded(true);
    replies.set("/ GetManagedObjects", Ok(managed(true, false)));
    const bus = iwdBus(replies);
    const seen = reports<Option<Wifi>>();

    watchIwdWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(
      Ok(
        Some({
          ...CONNECTED,
          connection: {
            bitrate: undefined,
            frequency: undefined,
            ip: undefined,
            ssid: "Home",
            strength: 44 / 60,
          },
        }),
      ),
    );
  });

  it("reads a device that is off, which has no station", async () => {
    const bus = iwdBus(recorded(false));
    const seen = reports<Option<Wifi>>();

    watchIwdWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(
      Ok(
        Some({
          ...CONNECTED,
          connection: undefined,
          enabled: false,
          networks: [],
        }),
      ),
    );
  });

  it("reads nothing without a device", async () => {
    const bus = iwdBus(
      new Map([
        [
          "/ GetManagedObjects",
          Ok({
            body: [{ "/net/connman/iwd": {} }],
            signature: "a{oa{sa{sv}}}",
          }),
        ],
      ]),
    );
    const seen = reports<Option<Wifi>>();

    watchIwdWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Ok(None()));
  });

  it("reports the error when iwd is not running", async () => {
    const bus = iwdBus(
      new Map([["/ GetManagedObjects", Err(SERVICE_UNKNOWN)]]),
    );
    const seen = reports<Option<Wifi>>();

    watchIwdWifi(bus.domicile, seen.on);

    expect(await seen.next()).toStrictEqual(Err(SERVICE_UNKNOWN));
  });

  it("reads again when a scan ends, and not for other objects", async () => {
    const replies = recorded(true);
    const bus = iwdBus(replies);
    const seen = reports<Option<Wifi>>();
    watchIwdWifi(bus.domicile, seen.on);
    await seen.next();

    await bus.send(
      propertiesChanged("/net/connman/iwd/0", `${IWD}.Adapter`, {
        Powered: v("b", true),
      }),
    );
    await bus.send(
      propertiesChanged(DEVICE, `${IWD}.Station`, { Scanning: v("b", false) }),
    );

    expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
    expect(seen.pending).toBe(0);
  });

  it("reads again when a saved network changes", async () => {
    const bus = iwdBus(recorded(true));
    const seen = reports<Option<Wifi>>();
    watchIwdWifi(bus.domicile, seen.on);
    await seen.next();

    await bus.send(
      propertiesChanged(KNOWN_OFFICE, `${IWD}.KnownNetwork`, {
        AutoConnect: v("b", true),
      }),
    );

    expect(await seen.next()).toStrictEqual(Ok(Some(CONNECTED)));
  });
});

describe("iwd Wi-Fi requests", () => {
  const request = (
    path: string,
    iface: string,
    member: string,
    body?: unknown[],
  ) => ({
    ...(body === undefined ? {} : { body, signature: "ssv" }),
    bus: Bus.System,
    destination: IWD,
    interface: iface,
    member,
    path,
  });

  it("turns the device off", async () => {
    const bus = iwdBus(new Map([[`${DEVICE} Set ${IWD}.Device`, Ok(DONE)]]));

    expect(
      await setIwdWifiEnabled(bus.domicile, CONNECTED, false),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      request(DEVICE, "org.freedesktop.DBus.Properties", "Set", [
        `${IWD}.Device`,
        "Powered",
        v("b", false),
      ]),
    ]);
  });

  it("scans", async () => {
    const bus = iwdBus(new Map([[`${DEVICE} Scan`, Ok(DONE)]]));

    expect(await scanIwdWifi(bus.domicile, CONNECTED)).toStrictEqual(
      Ok("done"),
    );
    expect(bus.calls).toStrictEqual([
      request(DEVICE, `${IWD}.Station`, "Scan"),
    ]);
  });

  it("disconnects", async () => {
    const bus = iwdBus(new Map([[`${DEVICE} Disconnect`, Ok(DONE)]]));

    expect(await disconnectIwdWifi(bus.domicile, CONNECTED)).toStrictEqual(
      Ok("done"),
    );
    expect(bus.calls).toStrictEqual([
      request(DEVICE, `${IWD}.Station`, "Disconnect"),
    ]);
  });

  it("forgets a saved network", async () => {
    const bus = iwdBus(new Map([[`${KNOWN_HOME} Forget`, Ok(DONE)]]));

    expect(
      await forgetIwdWifi(bus.domicile, CONNECTED, savedHome),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      request(KNOWN_HOME, `${IWD}.KnownNetwork`, "Forget"),
    ]);
  });

  it("stops joining a saved network by itself", async () => {
    const bus = iwdBus(
      new Map([[`${KNOWN_HOME} Set ${IWD}.KnownNetwork`, Ok(DONE)]]),
    );

    expect(
      await setIwdWifiAutoJoin(bus.domicile, CONNECTED, savedHome, false),
    ).toStrictEqual(Ok("done"));
    expect(bus.calls).toStrictEqual([
      request(KNOWN_HOME, "org.freedesktop.DBus.Properties", "Set", [
        `${IWD}.KnownNetwork`,
        "AutoConnect",
        v("b", false),
      ]),
    ]);
  });

  describe("connecting", () => {
    it.each([
      ["a known network", home],
      ["an open network", cafe],
    ])("connects %s over D-Bus", async (_name, network) => {
      const bus = iwdBus(new Map([[`${network.path} Connect`, Ok(DONE)]]));

      expect(
        await connectIwdWifi(bus.domicile, CONNECTED, network, undefined),
      ).toStrictEqual(Ok("done"));
      expect(bus.calls).toStrictEqual([
        request(network.path, `${IWD}.Network`, "Connect"),
      ]);
    });

    it("reports iwd's refusal", async () => {
      const refused: SystemError = {
        kind: SystemErrorKind.Dbus,
        message: "net.connman.iwd.Failed: Operation failed",
      };
      const bus = iwdBus(new Map([[`${HOME} Connect`, Err(refused)]]));

      expect(
        await connectIwdWifi(bus.domicile, CONNECTED, home, undefined),
      ).toStrictEqual(Err(refused));
    });

    /** A bus whose `run` resolves `ran` and records the argv. */
    const iwctl = (ran: Ran) => {
      const argv: (readonly string[])[] = [];
      const bus = fakeBus(() => {
        throw new Error("test: nothing should call D-Bus");
      });
      return {
        argv,
        domicile: {
          ...bus.domicile,
          processes: {
            run: (args: readonly string[]) => {
              argv.push(args);
              return Promise.resolve(Ok<Ran, SystemError>(ran));
            },
          },
        },
      };
    };

    it("joins a new secured network through iwctl, which answers iwd's agent", async () => {
      const run = iwctl({ code: 0, signal: undefined, stderr: "", stdout: "" });

      expect(
        await connectIwdWifi(
          run.domicile,
          CONNECTED,
          { ...home, profile: undefined },
          "hunter22",
        ),
      ).toStrictEqual(Ok("done"));
      expect(run.argv).toStrictEqual([
        [
          "iwctl",
          "--passphrase",
          "hunter22",
          "station",
          "wlan0",
          "connect",
          "Home",
        ],
      ]);
    });

    it("reports iwctl's failure with what it printed", async () => {
      const run = iwctl({
        code: 1,
        signal: undefined,
        stderr: "",
        stdout: "Operation failed\n",
      });

      expect(
        await connectIwdWifi(
          run.domicile,
          CONNECTED,
          { ...home, profile: undefined },
          "wrong",
        ),
      ).toStrictEqual(
        Err({ kind: SystemErrorKind.Other, message: "Operation failed" }),
      );
    });

    it("throws for a new secured network with no passphrase", () => {
      const bus = iwdBus(new Map());

      expect(
        connectIwdWifi(
          bus.domicile,
          CONNECTED,
          { ...home, profile: undefined },
          undefined,
        ),
      ).rejects.toThrow("needs a passphrase");
    });
  });
});
