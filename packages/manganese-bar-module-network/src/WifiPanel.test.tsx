import { describe, expect, it } from "bun:test";
import type { Option, Result } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";
import { Drilldown } from "@domicile-desktop/component-library/Drilldown";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import type { SystemError } from "@domicile-desktop/sdk/system";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import type { Addressing } from "@domicile-desktop/system-network/interfaces";
import type {
  Wifi,
  WifiConnection,
  WifiNetwork,
} from "@domicile-desktop/system-network/wifi";
import {
  WifiBackend,
  WifiSecurity,
} from "@domicile-desktop/system-network/wifi";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { heldWifiActions } from "./held-wifi-actions";
import { WifiPanel } from "./WifiPanel";

/** A host the panel never calls, since the library is injected. */
const NO_HOST = new FakeDomicileHost().domicile;

const DEVICE = "/org/freedesktop/NetworkManager/Devices/3";

const network = (ssid: string, changes: Partial<WifiNetwork>): WifiNetwork => ({
  connected: false,
  path: `/ap/${ssid}`,
  profile: undefined,
  secured: true,
  ssid,
  strength: 0.5,
  ...changes,
});

const home = network("Home", {
  connected: true,
  profile: "/profile/home",
  strength: 0.72,
});
const office = network("Office", { profile: "/profile/office", strength: 0.6 });
const cafe = network("Cafe", { secured: false, strength: 0.55 });
const neighbor = network("Neighbor", { strength: 0.2 });

const WIFI: Wifi = {
  backend: WifiBackend.NetworkManager,
  connection: {
    bitrate: 866.7,
    frequency: 5180,
    ip: {
      addresses: ["192.168.1.23/24"],
      dns: ["192.168.1.1", "1.1.1.1"],
      gateway: "192.168.1.1",
    },
    ssid: "Home",
    strength: 0.72,
  },
  device: DEVICE,
  enabled: true,
  hardwareAddress: "A4:C3:F0:85:AC:2D",
  interface: "wlan0",
  networks: [home, office, cafe, neighbor],
  saved: [
    {
      autoJoin: true,
      lastUsed: undefined,
      profile: "/profile/home",
      security: WifiSecurity.Password,
      ssid: "Home",
    },
  ],
  scanning: false,
};

/** What `ip` reads, which differs from the service's IPv4-only reading. */
const ADDRESSES = Ok<Map<string, Addressing>, SystemError>(
  new Map([
    [
      "wlan0",
      {
        gateway: "192.168.1.254",
        ipv4: ["192.168.1.23/24"],
        ipv6: ["2601:646:8d00:1a50:5c3e:91ff:fe2a:8b11/64"],
      },
    ],
  ]),
);

const REFUSED: SystemError = {
  kind: SystemErrorKind.Dbus,
  message: "org.freedesktop.NetworkManager.Device.NoSecrets: wrong passphrase",
};

/** The panel, once the scan it sends on showing has settled. */
const shown = async (
  wifi: Result<Option<Wifi>, SystemError> | undefined,
  held = heldWifiActions(),
  addresses: Result<Map<string, Addressing>, SystemError> = ADDRESSES,
) => {
  // In a drilldown, as in quick settings, for the saved networks' page.
  const rendered = render(
    <Drilldown>
      <WifiPanel
        actions={held.actions}
        addresses={addresses}
        host={NO_HOST}
        wifi={wifi}
      />
    </Drilldown>,
  );
  await act(() => Promise.resolve());
  return { ...held, ...rendered };
};

/** The panel, connected with `changes` to the connection. */
const shownWith = (changes: Partial<WifiConnection>) => {
  if (WIFI.connection === undefined) {
    throw new Error("test: WIFI is connected");
  } else {
    return shown(
      Ok(Some({ ...WIFI, connection: { ...WIFI.connection, ...changes } })),
    );
  }
};

/** Unfolds the connection's details. */
const unfold = () =>
  userEvent.click(screen.getByRole("button", { name: "Details" }));

/** Each term and its value's lines. */
const detailsIn = (within: ReturnType<typeof screen.getByRole>) =>
  Array.from(within.querySelectorAll("dt"), (term) => [
    term.textContent,
    Array.from(
      term.nextElementSibling?.childNodes ?? [],
      (line) => line.textContent,
    ),
  ]);

/** The list item that names `ssid`. */
const row = (ssid: string) => {
  const found = screen.getByText(ssid).closest("li");
  if (found === null) {
    throw new Error(`test: no row for ${ssid}`);
  } else {
    return within(found);
  }
};

/** The warning that says `text`, keeping the service's words for its tooltip. */
const expectWarning = (
  text: string,
  scope: Pick<typeof screen, "getByText"> = screen,
) => {
  const note = scope.getByText(text).closest("[role=status]");
  expect(note).toHaveAttribute("data-tone", "warning");
  expect(note).toHaveAttribute("title", REFUSED.message);
};

describe("WifiPanel", () => {
  it.each([
    [
      "the switch",
      "setEnabled",
      () => screen.getByRole("switch", { name: "Wi-Fi" }),
      "Couldn't turn Wi-Fi off",
    ],
    [
      "a scan",
      "scan",
      () => screen.getByRole("button", { name: "Scan" }),
      "Couldn't look for networks",
    ],
    [
      "disconnecting",
      "disconnect",
      async () => {
        await unfold();
        return screen.getByRole("button", { name: "Disconnect" });
      },
      "Couldn't disconnect",
    ],
  ])(
    "says plainly that the service refused %s",
    async (_name, refused, control, text) => {
      // The scan on showing goes through, so only the one asked for fails.
      const scans: string[] = [];
      await shown(
        Ok(Some(WIFI)),
        heldWifiActions(([name]) => {
          if (name === "scan") {
            scans.push(name);
          }
          return name === refused && (name !== "scan" || scans.length > 1)
            ? Err(REFUSED)
            : Ok("done");
        }),
      );

      await userEvent.click(await control());

      expectWarning(text);
    },
  );

  it("keeps a failed scan on showing to itself, since nobody asked for it", async () => {
    await shown(
      Ok(Some(WIFI)),
      heldWifiActions(([name]) =>
        name === "scan" ? Err(REFUSED) : Ok("done"),
      ),
    );

    expect(screen.queryByText("Couldn't look for networks")).toBeNull();
  });

  describe("before Wi-Fi is read", () => {
    it("stands in for the networks while it reads", async () => {
      await shown(undefined);

      expect(
        within(screen.getByRole("region", { name: "Wi-Fi" })).getByRole(
          "status",
        ),
      ).toHaveTextContent("Checking Wi-Fi…");
    });

    it("says so on a failure", async () => {
      await shown(Err(REFUSED));

      expect(screen.getByRole("region", { name: "Wi-Fi" })).toHaveTextContent(
        "Couldn't read Wi-Fi",
      );
    });

    it("shows nothing without a device", async () => {
      const { container } = await shown(Ok(None()));

      expect(container.textContent).toBe("");
    });
  });

  describe("its switch", () => {
    it("turns the radio off", async () => {
      const panel = await shown(Ok(Some(WIFI)));

      await userEvent.click(screen.getByRole("switch", { name: "Wi-Fi" }));

      expect(panel.asked).toContainEqual(["setEnabled", DEVICE, false]);
    });

    it("says the radio is off, and lists and scans nothing", async () => {
      const panel = await shown(
        Ok(
          Some({
            ...WIFI,
            connection: undefined,
            enabled: false,
            networks: [],
          }),
        ),
      );

      expect(screen.getByRole("switch", { name: "Wi-Fi" })).not.toBeChecked();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Wi-Fi is offTurn it on to see networks nearby.",
      );
      expect(panel.asked).toStrictEqual([]);
    });
  });

  describe("scanning", () => {
    it("scans when shown, and again on request", async () => {
      const panel = await shown(Ok(Some(WIFI)));
      expect(panel.asked).toStrictEqual([["scan", DEVICE]]);
      await userEvent.hover(screen.getByRole("button", { name: "Scan" }));
      expect(
        await screen.findByRole("tooltip", {}, { timeout: 2000 }),
      ).toHaveTextContent("Scan");

      await userEvent.click(screen.getByRole("button", { name: "Scan" }));

      expect(panel.asked).toStrictEqual([
        ["scan", DEVICE],
        ["scan", DEVICE],
      ]);
    });

    it("turns the Scan button while it scans, leaving the list be", async () => {
      await shown(Ok(Some({ ...WIFI, scanning: true })));

      expect(screen.getByRole("button", { name: "Scan" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("stands in for the networks while its first scan finds none", async () => {
      await shown(
        Ok(
          Some({
            ...WIFI,
            connection: undefined,
            networks: [],
            scanning: true,
          }),
        ),
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "Looking for networks…",
      );
    });

    it("says when nothing else is in range", async () => {
      await shown(Ok(Some({ ...WIFI, networks: [home] })));

      expect(screen.getByRole("status")).toHaveTextContent(
        "No other networks nearby",
      );
    });

    it("counts the saved networks on their button", async () => {
      await shown(Ok(Some(WIFI)));

      expect(
        screen.getByRole("button", { name: "1 saved" }),
      ).toBeInTheDocument();
    });

    it("says what to try when nothing at all is in range", async () => {
      await shown(Ok(Some({ ...WIFI, connection: undefined, networks: [] })));

      expect(screen.getByRole("status")).toHaveTextContent(
        "No networks nearbyMove closer to your router, then look again.Look again",
      );
      expect(screen.queryByRole("list", { name: "Networks" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Scan" })).toBeNull();
    });

    it("looks again when nothing at all is in range", async () => {
      const panel = await shown(
        Ok(Some({ ...WIFI, connection: undefined, networks: [] })),
      );

      await userEvent.click(screen.getByRole("button", { name: "Look again" }));

      expect(panel.asked).toStrictEqual([
        ["scan", DEVICE],
        ["scan", DEVICE],
      ]);
    });
  });

  describe("the connection", () => {
    it("leads the list, its details folded away", async () => {
      await shown(Ok(Some(WIFI)));

      const connected = within(
        screen.getByRole("list", { name: "Networks" }),
      ).getAllByRole("listitem")[0];
      expect(connected).toHaveTextContent(
        "HomeConnected · strong signal · 5 GHz",
      );
      expect(screen.queryByRole("term")).toBeNull();
    });

    it("shows its details, with its addresses from ip, one a line", async () => {
      await shown(Ok(Some(WIFI)));
      await unfold();

      expect(
        detailsIn(screen.getByRole("region", { name: "Wi-Fi" })),
      ).toStrictEqual([
        ["Speed", ["867 Mb/s"]],
        ["IPv4 address", ["192.168.1.23/24"]],
        ["IPv6 address", ["2601:646:8d00:1a50:5c3e:91ff:fe2a:8b11/64"]],
        ["Gateway", ["192.168.1.254"]],
        ["DNS", ["192.168.1.1", "1.1.1.1"]],
        ["Interface", ["wlan0"]],
        ["Hardware address", ["A4:C3:F0:85:AC:2D"]],
      ]);
    });

    it("offers to copy each address, server and name, but not the speed", async () => {
      await shown(Ok(Some(WIFI)));
      await unfold();

      expect(
        within(screen.getByRole("region", { name: "Wi-Fi" }))
          .getAllByRole("button", { name: /^Copy / })
          .map((button) => button.getAttribute("aria-label")),
      ).toStrictEqual([
        "Copy 192.168.1.23/24",
        "Copy 2601:646:8d00:1a50:5c3e:91ff:fe2a:8b11/64",
        "Copy 192.168.1.254",
        "Copy 192.168.1.1",
        "Copy 1.1.1.1",
        "Copy wlan0",
        "Copy A4:C3:F0:85:AC:2D",
      ]);
    });

    it("shows its addresses when the service reports none, as iwd does", async () => {
      await shownWith({ ip: undefined });
      await unfold();

      expect(
        screen.getAllByRole("term").map((term) => term.textContent),
      ).toStrictEqual([
        "Speed",
        "IPv4 address",
        "IPv6 address",
        "Gateway",
        "Interface",
        "Hardware address",
      ]);
    });

    it.each([
      [2412, "Connected · strong signal · 2.4 GHz"],
      [5955, "Connected · strong signal · 6 GHz"],
    ])("names %d MHz's band", async (frequency, shown) => {
      await shownWith({ frequency });

      expect(screen.getByText(shown)).toBeVisible();
    });

    it("leaves out what the service does not report", async () => {
      await shown(
        Ok(
          Some({
            ...WIFI,
            connection: {
              bitrate: undefined,
              frequency: undefined,
              ip: undefined,
              ssid: "Home",
              strength: 0.72,
            },
          }),
        ),
        heldWifiActions(),
        Ok(new Map()),
      );

      expect(screen.getByText("Connected · strong signal")).toBeVisible();
      await unfold();
      expect(
        screen.getAllByRole("term").map((term) => term.textContent),
      ).toStrictEqual(["Interface", "Hardware address"]);
    });

    it("disconnects from under the connection's details", async () => {
      const panel = await shown(Ok(Some(WIFI)));
      expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
      await unfold();

      await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));

      expect(panel.asked.slice(1)).toStrictEqual([["disconnect", DEVICE]]);
    });
  });

  describe("saved networks", () => {
    it("opens their page from the foot of the section", async () => {
      await shown(Ok(Some(WIFI)));

      await userEvent.click(
        screen.getByRole("button", { name: /^\d+ saved$/ }),
      );

      expect(
        within(screen.getByRole("list", { name: "Saved networks" })).getByText(
          "Connected · Secured",
        ),
      ).toBeVisible();
    });

    it("can be managed with the radio off", async () => {
      await shown(
        Ok(
          Some({
            ...WIFI,
            connection: undefined,
            enabled: false,
            networks: [],
          }),
        ),
      );

      expect(screen.getByRole("button", { name: /^\d+ saved$/ })).toBeVisible();
    });

    it("leaves the way in out when nothing is saved", async () => {
      await shown(Ok(Some({ ...WIFI, saved: [] })));

      expect(screen.queryByRole("button", { name: /^\d+ saved$/ })).toBeNull();
    });
  });

  describe("the networks", () => {
    it("lists the others, strongest first, marking saved and secured ones", async () => {
      await shown(Ok(Some(WIFI)));

      expect(
        within(screen.getByRole("list", { name: "Networks" }))
          .getAllByRole("button")
          .flatMap((button) => button.getAttribute("aria-label") ?? []),
      ).toStrictEqual([
        "Office, saved, secured, fair signal",
        "Cafe, fair signal",
        "Neighbor, secured, weak signal",
      ]);
    });

    it.each([
      ["a saved network", "Office"],
      ["an open network", "Cafe"],
    ])("joins %s on a click", async (_name, ssid) => {
      const panel = await shown(Ok(Some(WIFI)));

      await userEvent.click(row(ssid).getByRole("button"));

      expect(panel.asked.slice(1)).toStrictEqual([
        ["connect", DEVICE, ssid, undefined],
      ]);
    });

    it("asks for a new secured network's passphrase", async () => {
      const panel = await shown(Ok(Some(WIFI)));

      await userEvent.click(row("Neighbor").getByRole("button"));
      await userEvent.type(
        screen.getByLabelText("Passphrase for Neighbor"),
        "hunter22{Enter}",
      );

      expect(panel.asked.slice(1)).toStrictEqual([
        ["connect", DEVICE, "Neighbor", "hunter22"],
      ]);
    });

    it("says a network is connecting until the service answers", async () => {
      const held = heldWifiActions();
      const answer = Promise.withResolvers<Result<"done", SystemError>>();
      await shown(Ok(Some(WIFI)), {
        ...held,
        actions: { ...held.actions, connectWifi: () => answer.promise },
      });

      await userEvent.click(row("Office").getByRole("button"));

      expect(row("Office").getByText("Connecting…")).toBeVisible();
      // Its signal's arcs pulse in turn.
      expect(
        row("Office")
          .getByRole("button")
          .querySelectorAll("[data-part=arc][data-state=connecting]"),
      ).toHaveLength(3);
    });

    it("shows the service's refusal on the network's row", async () => {
      await shown(
        Ok(Some(WIFI)),
        heldWifiActions(([name]) =>
          name === "connect" ? Err(REFUSED) : Ok("done"),
        ),
      );

      await userEvent.click(row("Office").getByRole("button"));

      expectWarning("Couldn't connect to Office", row("Office"));
    });
  });
});
