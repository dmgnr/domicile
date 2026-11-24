import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DesktopStatus, LogindSignals, LoginManager } from "./power";
import { createPowerMonitor, createPowerSaveBlocker, onBattery } from "./power";

const supplies = (entries: Record<string, Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "power-supply-"));
  for (const [name, fields] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    for (const [field, value] of Object.entries(fields)) {
      writeFileSync(join(root, name, field), `${value}\n`);
    }
  }
  return root;
};

/** A logind that nobody hears from. */
const quietLogind: LoginManager = {
  delay: () => ({ stop: () => undefined }),
  follow: () => undefined,
};

/** A logind a test speaks for, writing down the delay locks held. */
const fakeLogind = () => {
  const held: string[] = [];
  const said: LogindSignals[] = [];
  const logind: LoginManager = {
    delay: (what) => {
      held.push(what);
      return { stop: () => held.splice(held.indexOf(what), 1) };
    },
    follow: (signals) => {
      said.push(signals);
    },
  };
  return { held, logind, said };
};

describe("powerMonitor", () => {
  it("says when the desktop locks and unlocks, not how it started", () => {
    let hear: (status: DesktopStatus) => void = () => undefined;
    const monitor = createPowerMonitor(
      (heard) => {
        hear = heard;
      },
      () => 0,
      quietLogind,
      () => false,
    );
    const seen: string[] = [];
    monitor.on("lock-screen", () => seen.push("lock"));
    monitor.on("unlock-screen", () => seen.push("unlock"));

    hear({ locked: false });
    hear({ locked: true });
    expect(monitor.getSystemIdleState(60)).toBe("locked");
    hear({ locked: true });
    hear({ locked: false });

    expect(seen).toEqual(["lock", "unlock"]);
    expect(monitor.getSystemIdleState(60)).toBe("active");
  });

  it("reads how long nobody has used the desktop", () => {
    let idle = 30;
    const monitor = createPowerMonitor(
      () => undefined,
      () => idle,
      quietLogind,
      () => false,
    );

    expect(monitor.getSystemIdleTime()).toBe(30);
    expect(monitor.getSystemIdleState(60)).toBe("active");
    idle = 60;
    expect(monitor.getSystemIdleState(60)).toBe("idle");
  });

  it("reads a locked desktop as locked however long it sat", () => {
    let hear: (status: DesktopStatus) => void = () => undefined;
    const monitor = createPowerMonitor(
      (heard) => {
        hear = heard;
      },
      () => 600,
      quietLogind,
      () => false,
    );

    monitor.getSystemIdleState(60);
    hear({ locked: true });

    expect(monitor.getSystemIdleState(60)).toBe("locked");
  });

  it("follows logind's sleep once the app listens, holding it off until the app has heard", () => {
    const { held, logind, said } = fakeLogind();
    const monitor = createPowerMonitor(
      () => undefined,
      () => 0,
      logind,
      () => false,
    );
    const seen: string[] = [];
    monitor.on("lock-screen", () => undefined);
    expect(said).toEqual([]);

    monitor.on("suspend", () => seen.push(`suspend, holding ${held}`));
    monitor.on("resume", () => seen.push(`resume, holding ${held}`));
    const signals = said[0];
    signals?.sleep(true);
    signals?.sleep(false);

    expect(said.length).toBe(1);
    expect(seen).toEqual(["suspend, holding sleep", "resume, holding sleep"]);
    expect(held).toEqual(["sleep"]);
  });

  it("holds shutdown off while the app listens, and past it when the app prevents it", () => {
    const { held, logind, said } = fakeLogind();
    const monitor = createPowerMonitor(
      () => undefined,
      () => 0,
      logind,
      () => false,
    );
    const listener = () => undefined;
    monitor.on("shutdown", listener);
    expect(held).toEqual(["sleep", "shutdown"]);
    monitor.off("shutdown", listener);
    expect(held).toEqual(["sleep"]);

    monitor.on("shutdown", (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    said[0]?.shutdown(true);
    expect(held).toEqual(["sleep", "shutdown"]);
  });

  it("lets shutdown go on once the app has heard and not prevented it", () => {
    const { held, logind, said } = fakeLogind();
    const monitor = createPowerMonitor(
      () => undefined,
      () => 0,
      logind,
      () => false,
    );
    const heard: string[] = [];
    monitor.on("shutdown", () => heard.push(`shutdown, holding ${held}`));

    said[0]?.shutdown(true);

    expect(heard).toEqual(["shutdown, holding sleep,shutdown"]);
    expect(held).toEqual(["sleep"]);
  });

  it("reads the battery from sysfs", () => {
    expect(
      onBattery(
        supplies({
          AC: { online: "0", type: "Mains" },
          BAT0: { status: "Discharging", type: "Battery" },
        }),
      ),
    ).toBe(true);
    expect(
      onBattery(
        supplies({
          AC: { online: "1", type: "Mains" },
          BAT0: { status: "Charging", type: "Battery" },
        }),
      ),
    ).toBe(false);
    expect(onBattery(join(tmpdir(), "no-such-power-supply"))).toBe(false);
  });
});

describe("powerSaveBlocker", () => {
  it("keeps an inhibitor running from start to stop", () => {
    const running: string[] = [];
    const blocker = createPowerSaveBlocker(() => {
      const name = `inhibitor ${running.length}`;
      running.push(name);
      return { stop: () => running.splice(running.indexOf(name), 1) };
    });

    const id = blocker.start("prevent-display-sleep");
    expect(blocker.isStarted(id)).toBe(true);
    expect(running).toEqual(["inhibitor 0"]);

    expect(blocker.stop(id)).toBe(true);
    expect(blocker.isStarted(id)).toBe(false);
    expect(running).toEqual([]);
  });
});
