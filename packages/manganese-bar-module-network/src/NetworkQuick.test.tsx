import { describe, expect, it } from "bun:test";
import type { Option, Result } from "@cprussin/option-result";
import { None, Ok, Some } from "@cprussin/option-result";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type { NetworkInterface } from "@domicile-desktop/system-network/interfaces";
import { InterfaceKind } from "@domicile-desktop/system-network/interfaces";
import type { Network as Reading } from "@domicile-desktop/system-network/network";
import { Connectivity, Link } from "@domicile-desktop/system-network/network";
import type { Wifi } from "@domicile-desktop/system-network/wifi";
import { WifiBackend } from "@domicile-desktop/system-network/wifi";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { held } from "./held-watch";
import { NetworkGlyph, NetworkTile } from "./NetworkQuick";

const CABLE: NetworkInterface = {
  hardwareAddress: "8c:16:45:5a:3e:01",
  kind: InterfaceKind.Wired,
  name: "enp0s31f6",
  speed: 1000,
  up: true,
};

const RADIO: NetworkInterface = {
  hardwareAddress: "a4:c3:f0:85:ac:2d",
  kind: InterfaceKind.Wireless,
  name: "wlan0",
  speed: undefined,
  up: true,
};

const WIFI: Wifi = {
  backend: WifiBackend.NetworkManager,
  connection: {
    bitrate: 866.7,
    frequency: 5180,
    ip: undefined,
    ssid: "Home",
    strength: 0.72,
  },
  device: "/org/freedesktop/NetworkManager/Devices/3",
  enabled: true,
  hardwareAddress: "A4:C3:F0:85:AC:2D",
  interface: "wlan0",
  networks: [],
  saved: [],
  scanning: false,
};

const online = (link: Reading["link"]) =>
  Ok<Reading, SystemError>({ connectivity: Connectivity.Full, link });

/** Details that open nowhere. */
const OPENS = { onMore: () => undefined };

/** The tile, with each watch held by the test. */
const tile = ({ onMore }: { onMore: (() => void) | undefined } = OPENS) => {
  const interfaces = held<Result<NetworkInterface[], SystemError>>();
  const wifi = held<Result<Option<Wifi>, SystemError>>();
  render(
    <NetworkTile
      interfaces={interfaces.watch}
      onMore={onMore}
      wifi={wifi.watch}
    />,
  );
  return { interfaces, wifi };
};

describe(NetworkGlyph, () => {
  it("shows nothing until the network service has answered", () => {
    const { container } = render(
      <NetworkGlyph
        interfaces={held<Result<NetworkInterface[], SystemError>>().watch}
        network={held<Result<Reading, SystemError>>().watch}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the Wi-Fi network, or the cable", () => {
    const network = held<Result<Reading, SystemError>>();
    const interfaces = held<Result<NetworkInterface[], SystemError>>();
    render(
      <NetworkGlyph interfaces={interfaces.watch} network={network.watch} />,
    );
    interfaces.report(Ok([RADIO]));
    network.report(online(Link.Wifi("Home", 0.9)));
    expect(
      screen.getByRole("img", { name: "Wi-Fi, strong signal: Home" }),
    ).toBeVisible();

    interfaces.report(Ok([CABLE]));
    network.report(online(Link.Wired("Wired connection 1")));

    expect(screen.getByRole("img", { name: "Wired" })).toBeVisible();
  });
});

describe(NetworkTile, () => {
  it("shows nothing until Wi-Fi has been read", () => {
    const { interfaces } = tile();
    interfaces.report(Ok([RADIO]));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the Wi-Fi network, and opens the details rather than switching", async () => {
    const opened = Promise.withResolvers<true>();
    const { interfaces, wifi } = tile({
      onMore: () => {
        opened.resolve(true);
      },
    });
    interfaces.report(Ok([RADIO]));
    wifi.report(Ok(Some(WIFI)));
    expect(screen.getByText("Home")).toBeVisible();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Wi-Fi details" }),
    ).toHaveAttribute("data-lit");

    await userEvent.click(
      screen.getByRole("button", { name: "Wi-Fi details" }),
    );

    expect(await opened.promise).toBe(true);
  });

  it.each([
    ["off", { connection: undefined, enabled: false }, "Off"],
    ["not connected", { connection: undefined }, "Not connected"],
  ])("says when Wi-Fi is %s", (_when, changes, text) => {
    const { interfaces, wifi } = tile();
    interfaces.report(Ok([RADIO]));
    wifi.report(Ok(Some({ ...WIFI, ...changes })));

    expect(screen.getByText(text)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Wi-Fi details" }),
    ).not.toHaveAttribute("data-lit");
  });

  it("is the wired tile with a cable in, even beside Wi-Fi", () => {
    const { interfaces, wifi } = tile();
    interfaces.report(Ok([CABLE, RADIO]));
    wifi.report(Ok(Some(WIFI)));

    expect(screen.queryByRole("button", { name: "Wi-Fi details" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Wired details" }),
    ).toHaveAttribute("data-lit");
    expect(screen.getByText("Connected, 1 Gb/s")).toBeVisible();
  });

  it("says when a machine without Wi-Fi has no cable in", () => {
    const { interfaces, wifi } = tile();
    interfaces.report(Ok([{ ...CABLE, speed: undefined, up: false }]));
    wifi.report(Ok(None()));

    expect(screen.getByText("No cable")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Wired details" }),
    ).not.toHaveAttribute("data-lit");
  });

  it("only shows the state without details to open", () => {
    const { interfaces, wifi } = tile({ onMore: undefined });
    interfaces.report(Ok([RADIO]));
    wifi.report(Ok(Some(WIFI)));

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Home")).toBeVisible();
  });
});
