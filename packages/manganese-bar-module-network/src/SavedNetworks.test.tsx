import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import type { SystemError } from "@domicile-desktop/sdk/system";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import type {
  SavedWifi,
  Wifi,
  WifiNetwork,
} from "@domicile-desktop/system-network/wifi";
import {
  WifiBackend,
  WifiSecurity,
} from "@domicile-desktop/system-network/wifi";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { heldWifiActions } from "./held-wifi-actions";
import { SavedNetworks } from "./SavedNetworks";

/** A host the page never calls, since the library is injected. */
const NO_HOST = new FakeDomicileHost().domicile;

const DEVICE = "/net/connman/iwd/0/4";

/** Wednesday afternoon, local time. */
const NOW = new Date(2026, 10, 18, 16, 0);

const network = (ssid: string, changes: Partial<WifiNetwork>): WifiNetwork => ({
  connected: false,
  path: `/network/${ssid}`,
  profile: `/known/${ssid}`,
  secured: true,
  ssid,
  strength: 0.5,
  ...changes,
});

const saved = (ssid: string, changes: Partial<SavedWifi>): SavedWifi => ({
  autoJoin: true,
  lastUsed: undefined,
  profile: `/known/${ssid}`,
  security: WifiSecurity.Password,
  ssid,
  ...changes,
});

/** In the service's order, which the page does not keep. */
const SAVED: SavedWifi[] = [
  saved("Library", { autoJoin: false, security: WifiSecurity.Enterprise }),
  saved("Airport", {
    lastUsed: new Date(2025, 6, 3),
    security: WifiSecurity.Open,
  }),
  saved("Gym", { lastUsed: new Date(2026, 10, 17, 19, 0) }),
  saved("Office", { lastUsed: new Date(2026, 10, 18, 9, 0) }),
  saved("Cafe", {
    lastUsed: new Date(2026, 8, 14),
    security: WifiSecurity.Open,
  }),
  saved("Home", { lastUsed: new Date(2026, 10, 18, 15, 0) }),
];

const WIFI: Wifi = {
  backend: WifiBackend.Iwd,
  connection: undefined,
  device: DEVICE,
  enabled: true,
  hardwareAddress: "a4:c3:f0:85:ac:2d",
  interface: "wlan0",
  networks: [
    network("Home", { connected: true }),
    network("Neighbor", { profile: undefined }),
    network("Office", {}),
  ],
  saved: SAVED,
  scanning: false,
};

const REFUSED: SystemError = {
  kind: SystemErrorKind.Dbus,
  message: "net.connman.iwd.NotFound: Object not found",
};

const shown = (wifi: Wifi = WIFI, held = heldWifiActions()) => {
  render(
    <SavedNetworks
      actions={held.actions}
      host={NO_HOST}
      now={NOW}
      wifi={wifi}
    />,
  );
  return held;
};

/** The list item that names `ssid`. */
const row = (ssid: string) => {
  const found = screen.getByText(ssid).closest("li");
  if (found === null) {
    throw new Error(`test: no row for ${ssid}`);
  } else {
    return within(found);
  }
};

describe("SavedNetworks", () => {
  it("lists the connected network, then those in range, then the rest by when they were last used", () => {
    shown();

    // Each tile reads its name, what it says under it, then its controls.
    expect(
      screen.getAllByRole("listitem").map(({ textContent }) => textContent),
    ).toStrictEqual(
      [
        "HomeConnected · Secured",
        "OfficeIn range · Used today · Secured",
        "GymUsed yesterday · Secured",
        "CafeUsed Sep 14 · Open",
        "AirportUsed Jul 3, 2025 · Open",
        "LibraryNever used · Enterprise",
      ].map((face) => `${face}Join automaticallyForget`),
    );
  });

  it("shows whether each joins automatically", () => {
    shown();

    expect(
      row("Home").getByRole("switch", { name: "Join automatically" }),
    ).toBeChecked();
    expect(
      row("Library").getByRole("switch", { name: "Join automatically" }),
    ).not.toBeChecked();
  });

  it("turns joining automatically off and on", async () => {
    const { asked } = shown();

    await userEvent.click(
      row("Home").getByRole("switch", { name: "Join automatically" }),
    );
    await userEvent.click(
      row("Library").getByRole("switch", { name: "Join automatically" }),
    );

    expect(asked).toStrictEqual([
      ["autoJoin", DEVICE, "Home", false],
      ["autoJoin", DEVICE, "Library", true],
    ]);
  });

  it("forgets a network", async () => {
    const { asked } = shown();

    await userEvent.click(row("Cafe").getByRole("button", { name: "Forget" }));

    expect(asked).toStrictEqual([["forget", DEVICE, "Cafe"]]);
  });

  it.each([
    ["forgetting", "forget", "button", "Forget", "Couldn't forget Cafe"],
    [
      "joining automatically",
      "autoJoin",
      "switch",
      "Join automatically",
      "Couldn't change Cafe",
    ],
  ] as const)(
    "says on the network's tile that the service refused %s",
    async (_name, refused, role, control, text) => {
      shown(
        WIFI,
        heldWifiActions(([name]) =>
          name === refused ? Err(REFUSED) : Ok("done"),
        ),
      );

      await userEvent.click(row("Cafe").getByRole(role, { name: control }));
      await act(() => Promise.resolve());

      const note = row("Cafe").getByText(text).closest("[role=status]");
      expect(note).toHaveAttribute("data-tone", "warning");
      expect(note).toHaveAttribute("title", REFUSED.message);
    },
  );

  it("says so once nothing is saved", () => {
    shown({ ...WIFI, saved: [] });

    expect(screen.getByText("No saved networks")).toBeVisible();
  });
});
