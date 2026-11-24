import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BluetoothDetails,
  BluetoothGlyph,
  BluetoothTile,
} from "./BluetoothQuick";
import { heldActions } from "./held-actions";
import { heldBluetooth, heldHardware, reading } from "./held-bluetooth";

describe(BluetoothGlyph, () => {
  it("shows nothing while no device is connected", () => {
    const bluetooth = heldBluetooth();
    const { container } = render(
      <BluetoothGlyph bluetooth={bluetooth.bluetooth} />,
    );
    bluetooth.report(reading(true, []));
    expect(container).toBeEmptyDOMElement();
  });

  it("names the connected devices", () => {
    const bluetooth = heldBluetooth();
    render(<BluetoothGlyph bluetooth={bluetooth.bluetooth} />);
    bluetooth.report(reading(true, ["WH-1000XM4"], { "WH-1000XM4": 80 }));
    expect(
      screen.getByRole("img", { name: "Bluetooth: WH-1000XM4 (80%)" }),
    ).toBeVisible();
  });

  it("warns when BlueZ fails", () => {
    const bluetooth = heldBluetooth();
    render(<BluetoothGlyph bluetooth={bluetooth.bluetooth} />);
    bluetooth.report(Err({ kind: SystemErrorKind.Dbus, message: "gone" }));
    expect(
      screen.getByRole("img", { name: "Bluetooth unavailable: gone" }),
    ).toBeVisible();
  });
});

describe(BluetoothTile, () => {
  it("shows nothing on a machine without Bluetooth hardware", () => {
    const bluetooth = heldBluetooth();
    const hardware = heldHardware();
    const { container } = render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={hardware.hardware}
      />,
    );
    hardware.report(Ok(false));
    expect(container).toBeEmptyDOMElement();
  });

  it("names the connected devices, and switches nothing", () => {
    const bluetooth = heldBluetooth();
    render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={heldHardware().hardware}
        onMore={() => undefined}
      />,
    );
    bluetooth.report(reading(true, ["WH-1000XM4"]));

    expect(screen.getByText("WH-1000XM4")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Bluetooth details" }),
    ).toHaveAttribute("data-lit");
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(screen.queryByRole("button", { pressed: false })).toBeNull();
  });

  it("says when it is on with nothing connected", () => {
    const bluetooth = heldBluetooth();
    render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={heldHardware().hardware}
        onMore={() => undefined}
      />,
    );
    bluetooth.report(reading(true, []));

    expect(screen.getByText("Not connected")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Bluetooth details" }),
    ).not.toHaveAttribute("data-lit");
  });

  it("opens its details", async () => {
    const bluetooth = heldBluetooth();
    const opened = Promise.withResolvers<true>();
    render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={heldHardware().hardware}
        onMore={() => {
          opened.resolve(true);
        }}
      />,
    );
    bluetooth.report(reading(false, []));
    expect(screen.getByText("Off")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Bluetooth details" }),
    );

    expect(await opened.promise).toBe(true);
  });

  it("only shows the state on a locked desktop", () => {
    const bluetooth = heldBluetooth();
    render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={heldHardware().hardware}
        locked
      />,
    );
    bluetooth.report(reading(true, []));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Not connected")).toBeVisible();
  });

  it("says why there is no adapter", () => {
    const bluetooth = heldBluetooth();
    const hardware = heldHardware();
    render(
      <BluetoothTile
        bluetooth={bluetooth.bluetooth}
        hardware={hardware.hardware}
      />,
    );
    hardware.report(Ok(true));
    bluetooth.report(Err({ kind: SystemErrorKind.Dbus, message: "gone" }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.queryByText(/gone/)).toBeNull();
  });
});

describe(BluetoothDetails, () => {
  const details = () => {
    const bluetooth = heldBluetooth();
    render(
      <BluetoothDetails
        actions={heldActions().actions}
        bluetooth={bluetooth.bluetooth}
        host={new FakeDomicileHost().domicile}
      />,
    );
    return bluetooth;
  };

  it("says it is checking until BlueZ answers", () => {
    details();
    expect(screen.getByRole("status")).toHaveTextContent("Checking Bluetooth…");
  });

  it("says plainly that BlueZ failed, with its words in the tooltip", () => {
    details().report(Err({ kind: SystemErrorKind.Dbus, message: "gone" }));
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Couldn't read Bluetooth");
    expect(note).toHaveAttribute("title", "gone");
  });

  it("lists the devices once BlueZ answers", () => {
    details().report(reading(true, ["WH-1000XM4"]));
    expect(screen.getByRole("region", { name: "Connected" })).toHaveTextContent(
      "WH-1000XM4",
    );
  });
});
