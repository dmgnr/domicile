import { describe, expect, it } from "bun:test";

import { device, laptop } from "./fixture";
import { routesOf } from "./routes";

const summary = (routes: ReturnType<typeof routesOf>) =>
  routes.map(({ detail, key, label, picked }) => ({
    detail,
    key,
    label,
    picked,
  }));

describe(routesOf, () => {
  it("names each plugged-in port, and a device without ports by its own name", () => {
    expect(summary(routesOf(laptop.outputs))).toStrictEqual([
      {
        detail: undefined,
        key: "output:speakers analog-output-speaker",
        label: "Speakers",
        picked: true,
      },
      {
        detail: undefined,
        key: "output:hdmi",
        label: "HDMI",
        picked: false,
      },
    ]);
  });

  it("leaves out monitors", () => {
    expect(summary(routesOf(laptop.inputs))).toStrictEqual([
      {
        detail: undefined,
        key: "input:mic",
        label: "Microphone",
        picked: true,
      },
    ]);
  });

  it("leaves out the hardware behind a filter, unless it is in use", () => {
    const filter = device({ description: "Corrected", id: "output:filter" });
    const hardware = device({ filtered: true });

    expect(summary(routesOf([filter, hardware]))).toStrictEqual([
      {
        detail: undefined,
        key: "output:filter",
        label: "Corrected",
        picked: true,
      },
    ]);
    expect(
      summary(routesOf([filter, { ...hardware, default: true }])).map(
        ({ key }) => key,
      ),
    ).toStrictEqual(["output:filter", "output:speakers"]);
  });

  it("keeps the port in use even with its jack empty", () => {
    const routes = routesOf([
      device({
        default: true,
        port: "headphones",
        ports: [
          { available: true, description: "Speakers", name: "speakers" },
          { available: false, description: "Headphones", name: "headphones" },
        ],
      }),
    ]);

    expect(routes.map(({ label, picked }) => [label, picked])).toStrictEqual([
      ["Speakers", false],
      ["Headphones", true],
    ]);
  });

  it("tells same-named ports apart by their device", () => {
    const speakers = { available: true, description: "Speakers", name: "s" };
    const routes = routesOf([
      device({
        default: true,
        description: "Built-in Audio",
        port: "s",
        ports: [speakers],
      }),
      device({
        description: "USB Dock",
        id: "output:dock",
        port: "s",
        ports: [speakers],
      }),
    ]);

    expect(routes.map(({ detail }) => detail)).toStrictEqual([
      "Built-in Audio",
      "USB Dock",
    ]);
  });

  it("picks the first device when none is the default", () => {
    expect(
      routesOf([
        device({}),
        device({ description: "HDMI", id: "output:hdmi" }),
      ]).map(({ picked }) => picked),
    ).toStrictEqual([true, false]);
  });
});
