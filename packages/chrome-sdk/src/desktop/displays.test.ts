import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { desktop } from "./desktop";

const display = {
  adaptiveSync: "unsupported" as const,
  hdr: "unsupported" as const,
  height: 1080,
  modeHeight: 1080,
  modeWidth: 1920,
  name: "left",
  peakLuminance: 0,
  refreshMhz: 60_000,
  scale: 1,
  sdrWhite: 0,
  transform: "rotate-90" as const,
  width: 1920,
  x: 0,
  y: 0,
};

describe("displays", () => {
  it("lists nothing until the compositor describes the desktop", () => {
    expect(desktop(new FakeDomicileHost().host).displays.list).toBeUndefined();
  });

  it("lists each screen, with an unknown rotation read as none", () => {
    const fake = new FakeDomicileHost();
    fake.set({ displays: [display, { ...display, transform: "flipped" }] });

    expect(desktop(fake.host).displays.list).toStrictEqual([
      display,
      { ...display, transform: "normal" },
    ]);
  });

  it("says whether each screen's adaptive sync is on, with an unknown state read as unsupported", () => {
    const fake = new FakeDomicileHost();
    fake.set({
      displays: [
        { ...display, adaptiveSync: "on" },
        { ...display, adaptiveSync: "off" },
        { ...display, adaptiveSync: "variable" },
      ],
    });

    expect(
      desktop(fake.host).displays.list?.map(({ adaptiveSync }) => adaptiveSync),
    ).toStrictEqual(["on", "off", "unsupported"]);
  });

  it("says whether each screen is in HDR, with an unknown state read as unsupported", () => {
    const fake = new FakeDomicileHost();
    fake.set({
      displays: [
        { ...display, hdr: "on", peakLuminance: 1000, sdrWhite: 203 },
        { ...display, hdr: "off", peakLuminance: 600 },
        { ...display, hdr: "dolby-vision" },
      ],
    });

    expect(
      desktop(fake.host).displays.list?.map(
        ({ hdr, peakLuminance, sdrWhite }) => [hdr, peakLuminance, sdrWhite],
      ),
    ).toStrictEqual([
      ["on", 1000, 203],
      ["off", 600, 0],
      ["unsupported", 0, 0],
    ]);
  });

  it("says the screens changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).displays.on("change", () => {
        resolve(undefined);
      });
    });
    fake.set({ displays: [] });

    expect(await changed).toBeUndefined();
  });
});

describe("addVirtual", () => {
  it("asks the compositor for a monitor with no connector", async () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .displays.addVirtual({
        height: 1080,
        name: "Living room TV",
        refreshMhz: 60_000,
        width: 1920,
      })
      .catch(() => {
        /* never answered */
      });
    await Promise.resolve();

    expect(
      fake.calls.map(([method, , request]) => [
        method,
        JSON.parse(String(request)),
      ]),
    ).toStrictEqual([
      [
        "callSystem",
        {
          call: "virtual_monitor",
          height: 1080,
          name: "Living room TV",
          refresh_mhz: 60_000,
          scale: 1,
          width: 1920,
        },
      ],
    ]);
  });
});

describe("sleep and wake", () => {
  it("asks the compositor to turn the monitors off, then on", async () => {
    const fake = new FakeDomicileHost();
    const { displays } = desktop(fake.host);
    for (const asked of [
      displays.sleep(),
      displays.wake(),
      displays.sleep("DP-1"),
      displays.wake("DP-1"),
    ]) {
      asked.catch(() => {
        /* never answered */
      });
    }
    await Promise.resolve();

    expect(
      fake.calls.map(([method, , request]) => [
        method,
        JSON.parse(String(request)),
      ]),
    ).toStrictEqual([
      ["callSystem", { call: "sleep_displays" }],
      ["callSystem", { call: "wake_displays" }],
      ["callSystem", { call: "sleep_displays", display: "DP-1" }],
      ["callSystem", { call: "wake_displays", display: "DP-1" }],
    ]);
  });
});

describe("setColorTemperature", () => {
  it("asks the compositor to warm every monitor", async () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .displays.setColorTemperature(3400)
      .catch(() => {
        /* never answered */
      });
    await Promise.resolve();

    expect(
      fake.calls.map(([method, , request]) => [
        method,
        JSON.parse(String(request)),
      ]),
    ).toStrictEqual([
      ["callSystem", { call: "set_color_temperature", kelvin: 3400 }],
    ]);
  });

  it("warms one monitor, by name", async () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .displays.setColorTemperature(3400, "eDP-2")
      .catch(() => {
        /* never answered */
      });
    await Promise.resolve();

    expect(
      fake.calls.map(([method, , request]) => [
        method,
        JSON.parse(String(request)),
      ]),
    ).toStrictEqual([
      [
        "callSystem",
        { call: "set_color_temperature", display: "eDP-2", kelvin: 3400 },
      ],
    ]);
  });
});
