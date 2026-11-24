import { describe, expect, it } from "bun:test";
import type { Option, Result } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";
import { PanelKeyboardContext } from "@domicile-desktop/manganese-bar/panel-keyboard";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import type { SystemError } from "@domicile-desktop/sdk/system";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import type {
  Addressing,
  NetworkInterface,
} from "@domicile-desktop/system-network/interfaces";
import { InterfaceKind } from "@domicile-desktop/system-network/interfaces";
import type { Network as Reading } from "@domicile-desktop/system-network/network";
import { Connectivity, Link } from "@domicile-desktop/system-network/network";
import type { Wifi } from "@domicile-desktop/system-network/wifi";
import {
  WifiBackend,
  WifiSecurity,
} from "@domicile-desktop/system-network/wifi";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { css } from "../styled-system/css";
import { held } from "./held-watch";
import { heldWifiActions } from "./held-wifi-actions";
import { Network } from "./Network";

const heldNetwork = () => held<Result<Reading, SystemError>>();

/** A host the item never calls, since the library is injected. */
const NO_HOST = new FakeDomicileHost().domicile;

const heldInterfaces = () => held<Result<NetworkInterface[], SystemError>>();

/** Holds nothing: for tests that do not look at the keyboard. */
const ignoreKeyboard = () => () => undefined;

/** The item, with the watches the test holds when given. */
const Item = ({
  addresses = held<Result<Map<string, Addressing>, SystemError>>().watch,
  hold = ignoreKeyboard,
  interfaces = heldInterfaces().watch,
  network,
  wifi = held<Result<Option<Wifi>, SystemError>>().watch,
}: {
  addresses?: SharedWatch<Result<Map<string, Addressing>, SystemError>>;
  hold?: () => () => void;
  interfaces?: SharedWatch<Result<NetworkInterface[], SystemError>>;
  network: SharedWatch<Result<Reading, SystemError>>;
  wifi?: SharedWatch<Result<Option<Wifi>, SystemError>>;
}) => (
  <PanelKeyboardContext value={hold}>
    <Network
      actions={heldWifiActions().actions}
      addresses={addresses}
      domicile={NO_HOST}
      interfaces={interfaces}
      network={network}
      wifi={wifi}
    />
  </PanelKeyboardContext>
);

const port = (up: boolean): NetworkInterface => ({
  hardwareAddress: "8c:16:45:5a:3e:01",
  kind: InterfaceKind.Wired,
  name: "enp0s31f6",
  speed: up ? 1000 : undefined,
  up,
});

const RADIO: NetworkInterface = {
  hardwareAddress: "a4:c3:f0:85:ac:2d",
  kind: InterfaceKind.Wireless,
  name: "wlan0",
  speed: undefined,
  up: false,
};

const online = (link: Reading["link"]) =>
  Ok<Reading, SystemError>({ connectivity: Connectivity.Full, link });

describe("Network", () => {
  it("shows nothing until the network service has answered", () => {
    const network = heldNetwork();

    const { container } = render(<Item network={network.watch} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing on a machine with no network hardware", () => {
    const network = heldNetwork();
    const interfaces = heldInterfaces();
    const { container } = render(
      <Item interfaces={interfaces.watch} network={network.watch} />,
    );

    network.report(online(Link.None()));
    interfaces.report(Ok([]));

    expect(container).toBeEmptyDOMElement();
  });

  it("shows, with a warning, when the network service fails", () => {
    const network = heldNetwork();
    const interfaces = heldInterfaces();
    render(<Item interfaces={interfaces.watch} network={network.watch} />);

    interfaces.report(Ok([RADIO]));
    network.report(
      Err({
        kind: SystemErrorKind.Dbus,
        message: "org.freedesktop.DBus.Error.ServiceUnknown",
      }),
    );

    expect(
      screen.getByRole("img", {
        name: "Network unavailable: org.freedesktop.DBus.Error.ServiceUnknown",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button").className).toContain(
      css({ color: "warning" }),
    );
  });

  it("shows once the hardware is read, before the service answers", () => {
    const interfaces = heldInterfaces();
    render(
      <Item interfaces={interfaces.watch} network={heldNetwork().watch} />,
    );

    interfaces.report(Ok([RADIO]));

    expect(
      screen.getByRole("img", { name: "Reading the network" }),
    ).toBeVisible();
  });

  describe("the link", () => {
    it("names a Wi-Fi network and grades its signal", () => {
      const network = heldNetwork();
      render(<Item network={network.watch} />);

      network.report(online(Link.Wifi("Home", 0.72)));
      expect(
        screen.getByRole("img", { name: "Wi-Fi, strong signal: Home" }),
      ).toBeVisible();

      network.report(online(Link.Wifi("Home", 0.5)));
      expect(
        screen.getByRole("img", { name: "Wi-Fi, fair signal: Home" }),
      ).toBeVisible();

      network.report(online(Link.Wifi("Home", 0.2)));
      expect(
        screen.getByRole("img", { name: "Wi-Fi, weak signal: Home" }),
      ).toBeVisible();
    });

    it("shows only an icon, and names the link on hover", async () => {
      const network = heldNetwork();
      render(<Item network={network.watch} />);

      network.report(online(Link.Wifi("Home", 0.72)));

      expect(screen.queryByText("Home")).not.toBeInTheDocument();
      await userEvent.hover(screen.getByRole("button"));
      expect(
        await screen.findByRole("tooltip", {}, { timeout: 2000 }),
      ).toHaveTextContent("Wi-Fi, strong signal: Home");
    });

    it("marks a wired link", () => {
      const network = heldNetwork();
      render(<Item network={network.watch} />);

      network.report(online(Link.Wired("Wired connection 1")));

      expect(screen.getByRole("img", { name: "Wired" })).toBeVisible();
    });

    it("marks a cable the service does not report, such as iwd's", () => {
      const network = heldNetwork();
      const interfaces = heldInterfaces();
      render(<Item interfaces={interfaces.watch} network={network.watch} />);

      network.report(
        Ok({ connectivity: Connectivity.Unknown, link: Link.None() }),
      );
      interfaces.report(Ok([port(false), RADIO]));
      expect(screen.getByRole("img", { name: "Offline" })).toBeVisible();

      interfaces.report(Ok([port(true), RADIO]));
      expect(screen.getByRole("img", { name: "Wired" })).toBeVisible();
    });

    it("names a cable beside Wi-Fi", () => {
      const network = heldNetwork();
      const interfaces = heldInterfaces();
      render(<Item interfaces={interfaces.watch} network={network.watch} />);

      network.report(online(Link.Wifi("Home", 0.72)));
      interfaces.report(Ok([port(true), RADIO]));

      expect(
        screen.getByRole("img", { name: "Wi-Fi, strong signal: Home; Wired" }),
      ).toBeVisible();
    });

    it("names any other link", () => {
      const network = heldNetwork();
      render(<Item network={network.watch} />);

      network.report(online(Link.Other("wg0")));

      expect(screen.getByRole("img", { name: "Network: wg0" })).toBeVisible();
    });

    it("says when there is none, dimmed", () => {
      const network = heldNetwork();
      render(<Item network={network.watch} />);

      network.report(online(Link.Wired("Wired connection 1")));
      expect(screen.getByRole("button").className).not.toContain(
        css({ "& > svg": { opacity: "inactive" } }),
      );

      network.report(online(Link.None()));
      expect(screen.getByRole("img", { name: "Offline" })).toBeVisible();
      expect(screen.getByRole("button").className).toContain(
        css({ "& > svg": { opacity: "inactive" } }),
      );
    });
  });

  it("warns when the link does not reach the internet", () => {
    const network = heldNetwork();
    render(<Item network={network.watch} />);

    network.report(online(Link.Wifi("Cafe", 0.9)));
    expect(screen.getByRole("button").className).not.toContain(
      css({ color: "warning" }),
    );

    for (const connectivity of [Connectivity.Limited, Connectivity.Portal]) {
      network.report(Ok({ connectivity, link: Link.Wifi("Cafe", 0.9) }));
      expect(screen.getByRole("button").className).toContain(
        css({ color: "warning" }),
      );
    }
    expect(
      screen.getByRole("img", {
        name: "Wi-Fi, strong signal: Cafe, no internet",
      }),
    ).toBeVisible();
  });

  it("stops watching when it goes away", () => {
    const network = heldNetwork();
    const { unmount } = render(<Item network={network.watch} />);

    unmount();

    expect(network.stopped).toBe(1);
  });

  describe("its panel", () => {
    it("keeps the keyboard while open, for the Wi-Fi password", async () => {
      // The compositor sends keys to the focused window, not the page,
      // unless the panel holds the keyboard.
      const network = heldNetwork();
      const keyboard = { held: 0, released: 0 };
      render(
        <Item
          hold={() => {
            keyboard.held += 1;
            return () => {
              keyboard.released += 1;
            };
          }}
          network={network.watch}
        />,
      );
      network.report(online(Link.Wifi("Home", 0.72)));
      expect(keyboard).toStrictEqual({ held: 0, released: 0 });

      await userEvent.click(
        screen.getByRole("button", { name: "Wi-Fi, strong signal: Home" }),
      );
      expect(keyboard).toStrictEqual({ held: 1, released: 0 });

      await userEvent.keyboard("{Escape}");
      expect(keyboard).toStrictEqual({ held: 1, released: 1 });
    });

    it("opens on a click, and reads Wi-Fi and the addresses only while open", async () => {
      const network = heldNetwork();
      const wifi = held<Result<Option<Wifi>, SystemError>>();
      const addresses = held<Result<Map<string, Addressing>, SystemError>>();
      render(
        <Item
          addresses={addresses.watch}
          network={network.watch}
          wifi={wifi.watch}
        />,
      );
      network.report(online(Link.Wifi("Home", 0.72)));
      expect(wifi.started).toBe(0);
      expect(addresses.started).toBe(0);

      await userEvent.click(
        screen.getByRole("button", { name: "Wi-Fi, strong signal: Home" }),
      );
      wifi.report(Ok(None()));

      expect(screen.getByRole("status")).toHaveTextContent(
        "No Wi-Fi or network port",
      );
      expect(
        screen.queryByRole("region", { name: "Wired" }),
      ).not.toBeInTheDocument();
      expect(wifi.started).toBe(1);
      expect(addresses.started).toBe(1);

      await userEvent.keyboard("{Escape}");

      expect(wifi.stopped).toBe(1);
      expect(addresses.stopped).toBe(1);
    });

    it("opens the saved networks' page", async () => {
      const network = heldNetwork();
      const wifi = held<Result<Option<Wifi>, SystemError>>();
      render(<Item network={network.watch} wifi={wifi.watch} />);
      network.report(online(Link.None()));
      await userEvent.click(screen.getByRole("button"));
      wifi.report(
        Ok(
          Some({
            backend: WifiBackend.Iwd,
            connection: undefined,
            device: "/net/connman/iwd/0/4",
            enabled: false,
            hardwareAddress: "a4:c3:f0:85:ac:2d",
            interface: "wlan0",
            networks: [],
            saved: [
              {
                autoJoin: true,
                lastUsed: undefined,
                profile: "/net/connman/iwd/486f6d65_psk",
                security: WifiSecurity.Password,
                ssid: "Home",
              },
            ],
            scanning: false,
          }),
        ),
      );

      await userEvent.click(
        screen.getByRole("button", { name: /^\d+ saved$/ }),
      );

      expect(
        screen.getByRole("list", { name: "Saved networks" }),
      ).toHaveTextContent("Home");
    });

    it("shows each wired port, with its addresses one a line while open", async () => {
      const network = heldNetwork();
      const interfaces = heldInterfaces();
      const addresses = held<Result<Map<string, Addressing>, SystemError>>();
      render(
        <Item
          addresses={addresses.watch}
          interfaces={interfaces.watch}
          network={network.watch}
        />,
      );
      network.report(online(Link.Wired("Wired connection 1")));
      interfaces.report(Ok([port(true), RADIO]));

      await userEvent.click(screen.getByRole("button", { name: "Wired" }));
      await userEvent.click(screen.getByRole("button", { name: "Details" }));
      addresses.report(
        Ok(
          new Map([
            [
              "enp0s31f6",
              {
                gateway: "192.168.1.1",
                ipv4: ["192.168.1.40/24"],
                ipv6: ["fd00::8e16:45ff:fe5a:3e01/64"],
              },
            ],
          ]),
        ),
      );

      const wired = screen.getByRole("region", { name: "Wired" });
      expect(wired).toHaveTextContent("Connected1 Gb/s");
      expect(wired).toHaveTextContent("192.168.1.40/24");
      expect(wired).toHaveTextContent("fd00::8e16:45ff:fe5a:3e01/64");
      expect(wired).toHaveTextContent("192.168.1.1");
      expect(wired).toHaveTextContent("8c:16:45:5a:3e:01");
      expect(
        within(wired)
          .getAllByRole("button", { name: /^Copy / })
          .map((button) => button.getAttribute("aria-label")),
      ).toStrictEqual([
        "Copy 192.168.1.40/24",
        "Copy fd00::8e16:45ff:fe5a:3e01/64",
        "Copy 192.168.1.1",
        "Copy enp0s31f6",
        "Copy 8c:16:45:5a:3e:01",
      ]);
      expect(addresses.started).toBe(1);

      await userEvent.keyboard("{Escape}");
      expect(addresses.stopped).toBe(1);
    });

    it("says when a port has no cable, on a machine without Wi-Fi", async () => {
      const network = heldNetwork();
      const interfaces = heldInterfaces();
      const wifi = held<Result<Option<Wifi>, SystemError>>();
      render(
        <Item
          interfaces={interfaces.watch}
          network={network.watch}
          wifi={wifi.watch}
        />,
      );
      network.report(online(Link.None()));
      interfaces.report(Ok([port(false)]));

      await userEvent.click(screen.getByRole("button", { name: "Offline" }));
      wifi.report(Ok(None()));

      expect(screen.getByRole("region", { name: "Wired" })).toHaveTextContent(
        "No cable",
      );
    });

    it("leaves out a port with no cable beside Wi-Fi", async () => {
      const network = heldNetwork();
      const interfaces = heldInterfaces();
      const wifi = held<Result<Option<Wifi>, SystemError>>();
      render(
        <Item
          interfaces={interfaces.watch}
          network={network.watch}
          wifi={wifi.watch}
        />,
      );
      network.report(online(Link.None()));
      interfaces.report(Ok([port(false), RADIO]));

      await userEvent.click(screen.getByRole("button", { name: "Offline" }));
      wifi.report(Err({ kind: SystemErrorKind.Dbus, message: "gone" }));

      expect(screen.queryByRole("region", { name: "Wired" })).toBeNull();
      expect(screen.getByRole("region", { name: "Wi-Fi" })).toBeVisible();
    });
  });
});
