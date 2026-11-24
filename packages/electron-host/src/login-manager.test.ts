import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { MessageBus } from "dbus-next";
import { sessionBus } from "dbus-next";
import { startFakeDesktopBus } from "./desktop-bus-fixture";
import { followLogind } from "./login-manager";

describe(followLogind, () => {
  let desktopBus: Awaited<ReturnType<typeof startFakeDesktopBus>>;
  let bus: MessageBus;
  beforeAll(async () => {
    desktopBus = await startFakeDesktopBus({ colorScheme: 0, contrast: 0 });
    bus = sessionBus({ busAddress: desktopBus.address });
  });
  afterAll(async () => {
    bus.disconnect();
    await desktopBus.close();
  });

  it("hands on each PrepareForSleep and PrepareForShutdown logind sends", async () => {
    const heard: string[] = [];
    let done: () => void = () => undefined;
    const all = new Promise<void>((resolve) => {
      done = resolve;
    });
    await followLogind(bus, {
      shutdown: (start) => {
        heard.push(`shutdown ${start}`);
        done();
      },
      sleep: (start) => heard.push(`sleep ${start}`),
    });

    desktopBus.logind.PrepareForSleep(true);
    desktopBus.logind.PrepareForSleep(false);
    desktopBus.logind.PrepareForShutdown(true);
    await all;

    expect(heard).toEqual(["sleep true", "sleep false", "shutdown true"]);
  });
});
