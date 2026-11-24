import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecondInstance } from "./single-instance";
import { createSingleInstanceLock, LOCK } from "./single-instance";

const launch = (argv: string[]): SecondInstance => ({
  additionalData: { from: argv[0] },
  argv,
  workingDirectory: "/home/someone",
});

describe("the single-instance lock", () => {
  it("goes to the first instance, and a later one hands it its launch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "single-instance-"));
    const heard: SecondInstance[] = [];
    const first = createSingleInstanceLock(
      () => dir,
      (l) => heard.push(l),
    );
    // A later instance is another process: another pid, the parent's.
    const second = createSingleInstanceLock(
      () => dir,
      () => undefined,
      process.ppid,
    );

    expect(first.request(launch(["slack"]))).toBe(true);
    expect(first.has()).toBe(true);
    expect(second.request(launch(["slack", "slack://open"]))).toBe(false);
    expect(second.has()).toBe(false);

    for (let tries = 0; heard.length === 0 && tries < 100; tries++) {
      await Bun.sleep(10);
    }
    expect(heard).toEqual([launch(["slack", "slack://open"])]);
    first.release();
  });

  it("is free again once released", () => {
    const dir = mkdtempSync(join(tmpdir(), "single-instance-"));
    const first = createSingleInstanceLock(
      () => dir,
      () => undefined,
    );
    const second = createSingleInstanceLock(
      () => dir,
      () => undefined,
      process.ppid,
    );

    first.request(launch(["a"]));
    first.release();

    expect(second.request(launch(["b"]))).toBe(true);
    second.release();
  });

  it("is free when the instance that held it died", () => {
    const dir = mkdtempSync(join(tmpdir(), "single-instance-"));
    // A pid with another start time: what a dead instance leaves.
    writeFileSync(join(dir, LOCK), `${process.ppid} 1`);

    const lock = createSingleInstanceLock(
      () => dir,
      () => undefined,
    );

    expect(lock.request(launch(["a"]))).toBe(true);
    lock.release();
  });
});
