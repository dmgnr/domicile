import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, render, screen } from "@testing-library/react";

import { useDisplays } from "./displays";
import { DomicileProvider } from "./domicile-provider";

const Names = () => {
  const displays = useDisplays();
  return (
    <span>
      {displays === undefined
        ? "waiting"
        : displays.map(({ name }) => name).join(", ")}
    </span>
  );
};

describe("useDisplays", () => {
  it("is undefined until the compositor describes the screens, then each change", () => {
    const fake = new FakeDomicileHost();
    render(
      <DomicileProvider domicile={fake.domicile}>
        <Names />
      </DomicileProvider>,
    );
    expect(screen.getByText("waiting")).toBeInTheDocument();

    act(() => {
      fake.set({
        displays: [
          {
            adaptiveSync: "unsupported",
            hdr: "unsupported",
            height: 1080,
            modeHeight: 1080,
            modeWidth: 1920,
            name: "eDP-1",
            peakLuminance: 0,
            refreshMhz: 60_000,
            scale: 1,
            sdrWhite: 0,
            transform: "normal",
            width: 1920,
            x: 0,
            y: 0,
          },
        ],
      });
    });

    expect(screen.getByText("eDP-1")).toBeInTheDocument();
  });
});
