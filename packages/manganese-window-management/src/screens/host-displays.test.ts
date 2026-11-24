import { describe, expect, it } from "bun:test";
import type { Display } from "@domicile-desktop/component-library/display-source";
import type { DomicileDisplay } from "@domicile-desktop/sdk/domicile-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";

import { hostDisplays } from "./host-displays";

/** One screen, as the engine describes it. */
const LEFT: DomicileDisplay = {
  adaptiveSync: "unsupported",
  hdr: "unsupported",
  height: 1080,
  modeHeight: 1080,
  modeWidth: 1920,
  name: "left",
  peakLuminance: 0,
  refreshMhz: 60_000,
  scale: 1,
  sdrWhite: 0,
  transform: "normal",
  width: 1920,
  x: 0,
  y: 0,
};
const RIGHT: DomicileDisplay = { ...LEFT, name: "right", x: 1920 };

/** The same screen, as `<Screen>` expects it. */
const LEFT_LAID_OUT: Display = {
  name: "left",
  position: [0, 0],
  scale: 1,
  size: [1920, 1080],
};
const RIGHT_LAID_OUT: Display = {
  ...LEFT_LAID_OUT,
  name: "right",
  position: [1920, 0],
};

/** A fake host that only describes a desktop. */
const connected = () => {
  const fake = new FakeDomicileHost();
  return [
    fake.domicile,
    {
      describes: (displays: readonly DomicileDisplay[]) => {
        fake.set({ displays });
      },
    },
  ] as const;
};

describe("the desktop a shell lays out against", () => {
  it("is regrouped into the rectangle the layout wants", () => {
    // Both shapes use the same logical CSS pixels. The engine uses four numbers
    // (WebIDL has no tuples) and `<Screen>` uses two pairs; regrouping them is
    // this module's job.
    const [client, host] = connected();

    host.describes([LEFT]);

    expect(hostDisplays(client).displays).toStrictEqual([LEFT_LAID_OUT]);
  });

  it("reads the domicile when asked, not when built", () => {
    // A snapshot at construction would give a later-mounted provider a stale
    // desktop.
    const [client, host] = connected();
    const source = hostDisplays(client);
    expect(source.displays).toBeUndefined();

    host.describes([LEFT]);

    expect(source.displays).toStrictEqual([LEFT_LAID_OUT]);
  });

  it("passes on every desktop after that", () => {
    const [client, host] = connected();
    const seen: (readonly unknown[])[] = [];
    hostDisplays(client).onDisplays((displays) => {
      seen.push(displays);
    });

    host.describes([LEFT]);
    host.describes([LEFT, RIGHT]);

    expect(seen).toStrictEqual([
      [LEFT_LAID_OUT],
      [LEFT_LAID_OUT, RIGHT_LAID_OUT],
    ]);
  });

  it("stops when the teardown runs", () => {
    const [client, host] = connected();
    const seen: unknown[] = [];
    const stop = hostDisplays(client).onDisplays((displays) => {
      seen.push(displays);
    });

    stop();
    host.describes([LEFT]);

    expect(seen).toStrictEqual([]);
  });

  it("lets go of its own handler and no other", () => {
    // A page draws a provider per source. Removing every listener on teardown
    // would silence the live one, and the desktop would stop updating.
    const [client, host] = connected();
    const source = hostDisplays(client);
    const seen: unknown[] = [];

    const stopFirst = source.onDisplays(() => {
      throw new Error("the stopped handler was called");
    });
    source.onDisplays((displays) => {
      seen.push(displays);
    });
    stopFirst();

    host.describes([LEFT]);

    expect(seen).toStrictEqual([[LEFT_LAID_OUT]]);
  });
});
