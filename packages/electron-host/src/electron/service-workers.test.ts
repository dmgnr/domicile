import { describe, expect, it } from "bun:test";
import { createServiceWorkers } from "./service-workers";
import type { RunningServiceWorker } from "./session-calls";

const worker = (version: number): RunningServiceWorker => ({
  render_process_id: 7,
  scope: "https://a.test/",
  script_url: "https://a.test/sw.js",
  version_id: version,
});

const setUp = (running: RunningServiceWorker[] = []) => {
  let watched = 0;
  const { serviceWorkers, heard } = createServiceWorkers(() => {
    watched += 1;
    return Promise.resolve(running);
  });
  return { heard, serviceWorkers, watched: () => watched };
};

describe(createServiceWorkers, () => {
  it("watches once, and knows the workers running then", async () => {
    const { serviceWorkers, watched } = setUp([worker(1)]);
    await Promise.resolve();

    expect(watched()).toBe(1);
    expect(serviceWorkers.getAllRunning()).toEqual({
      1: {
        renderProcessId: 7,
        scope: "https://a.test/",
        scriptUrl: "https://a.test/sw.js",
        versionId: 1,
      },
    });
    expect(serviceWorkers.getInfoFromVersionID(1)).toEqual(
      serviceWorkers.getFromVersionID(1),
    );
  });

  it("follows each worker's running status and says it", async () => {
    const { heard, serviceWorkers } = setUp();
    await Promise.resolve();
    const statuses: unknown[] = [];
    serviceWorkers.on("running-status-changed", (details) =>
      statuses.push(details),
    );

    heard({
      event: "running_status",
      running_status: "running",
      session: "",
      type: "service_worker",
      version_id: 2,
      worker: worker(2),
    });
    expect(Object.keys(serviceWorkers.getAllRunning())).toEqual(["2"]);
    heard({
      event: "running_status",
      running_status: "stopped",
      session: "",
      type: "service_worker",
      version_id: 2,
    });

    expect(serviceWorkers.getAllRunning()).toEqual({});
    expect(statuses).toMatchObject([
      { runningStatus: "running", versionId: 2 },
      { runningStatus: "stopped", versionId: 2 },
    ]);
  });

  it("says a registration and a worker's console message as Electron does", async () => {
    const { heard, serviceWorkers } = setUp();
    await Promise.resolve();
    const said: unknown[] = [];
    serviceWorkers.on("registration-completed", (_event, details) =>
      said.push(details),
    );
    serviceWorkers.on("console-message", (_event, details) =>
      said.push(details),
    );

    heard({
      event: "registration_completed",
      scope: "https://a.test/",
      session: "",
      type: "service_worker",
    });
    heard({
      event: "console_message",
      level: 2,
      line_number: 3,
      message: "hi",
      session: "",
      source: "console-api",
      source_url: "https://a.test/sw.js",
      type: "service_worker",
      version_id: 2,
    });

    expect(said).toEqual([
      { scope: "https://a.test/" },
      {
        level: 2,
        lineNumber: 3,
        message: "hi",
        source: "console-api",
        sourceUrl: "https://a.test/sw.js",
        versionId: 2,
      },
    ]);
  });

  it("throws for a worker that isn't running, as Electron does", async () => {
    const { serviceWorkers } = setUp();
    await Promise.resolve();

    expect(() => serviceWorkers.getInfoFromVersionID(9)).toThrow(
      "no service worker with version 9 is running",
    );
  });
});
