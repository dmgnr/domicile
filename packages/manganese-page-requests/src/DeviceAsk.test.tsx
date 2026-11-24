import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceAsk } from "./DeviceAsk";
import type { DeviceRequest } from "./useDeviceRequest";

const TITLE = "wallet.example wants to connect to a HID device";

/** A request offering `devices`, recording its answers. */
const requestFor = (
  devices: DeviceRequest["devices"],
  answers: string[],
): DeviceRequest => ({
  cancel: () => {
    answers.push("cancel");
  },
  choose: (id) => {
    answers.push(`choose ${id}`);
  },
  devices,
  title: TITLE,
});

const connect = (): HTMLElement =>
  screen.getByRole("button", { name: "Connect" });

describe("DeviceAsk", () => {
  it("asks Chrome's question", () => {
    render(<DeviceAsk request={requestFor([], [])} />);

    expect(screen.getByRole("region", { name: TITLE })).toBeInTheDocument();
  });

  it("says it is looking until the devices are listed", () => {
    render(<DeviceAsk request={requestFor(undefined, [])} />);

    expect(screen.getByText("Looking for devices…")).toBeInTheDocument();
    expect(connect()).toBeDisabled();
  });

  it("says when no device fits", () => {
    render(<DeviceAsk request={requestFor([], [])} />);

    expect(screen.getByText("No devices found")).toBeInTheDocument();
  });

  it("connects the device the user picks", async () => {
    const answers: string[] = [];
    render(
      <DeviceAsk
        request={requestFor(
          [
            { id: 1, name: "Keyboard" },
            { id: 2, name: "Nano X" },
          ],
          answers,
        )}
      />,
    );
    expect(connect()).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "Nano X" }));
    await userEvent.click(connect());

    expect(answers).toStrictEqual(["choose 2"]);
  });

  // It was picked as it was unplugged.
  it("forgets a picked device that is removed", async () => {
    const request = requestFor([{ id: 2, name: "Nano X" }], []);
    const { rerender } = render(<DeviceAsk request={request} />);
    await userEvent.click(screen.getByRole("radio", { name: "Nano X" }));

    rerender(<DeviceAsk request={{ ...request, devices: [] }} />);

    expect(connect()).toBeDisabled();
  });

  it("cancels", async () => {
    const answers: string[] = [];
    render(<DeviceAsk request={requestFor([], answers)} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(answers).toStrictEqual(["cancel"]);
  });
});
