// The stand-in for Electron's `ServiceWorkers`, a session's `serviceWorkers`:
// the engine says each change to the session's service workers from the
// watch on, and the host keeps which are running. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";

import type { RunningServiceWorker } from "./session-calls";

/** A change to a session's service workers, as the engine says it. */
export type ServiceWorkerEvent =
  | {
      readonly type: "service_worker";
      readonly session: string;
      readonly event: "running_status";
      readonly version_id: number;
      readonly running_status: "starting" | "running" | "stopping" | "stopped";
      /** With "running": the worker that runs. */
      readonly worker?: RunningServiceWorker | undefined;
    }
  | {
      readonly type: "service_worker";
      readonly session: string;
      readonly event: "registration_completed";
      readonly scope: string;
    }
  | {
      readonly type: "service_worker";
      readonly session: string;
      readonly event: "console_message";
      readonly version_id: number;
      readonly message: string;
      readonly source: string;
      readonly level: number;
      readonly source_url: string;
      readonly line_number: number;
    };

/** Electron's `ServiceWorkerInfo`. */
export type ServiceWorkerInfo = {
  readonly scriptUrl: string;
  readonly scope: string;
  readonly renderProcessId: number;
  readonly versionId: number;
};

/**
 * A session's `serviceWorkers`, which `watch` has the engine report on from
 * the start; `heard` takes each report.
 */
export const createServiceWorkers = (
  watch: () => Promise<RunningServiceWorker[]>,
) => {
  const running = new Map<number, ServiceWorkerInfo>();
  const emitter = new EventEmitter();
  // A refusal is the engine's bug, and fails loudly.
  watch()
    .then((workers) => {
      for (const worker of workers) {
        running.set(worker.version_id, infoOf(worker));
      }
    })
    .catch((error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: a refusal is the engine's bug
      console.error("the engine refused to watch service workers", error);
    });

  const getInfoFromVersionID = (versionId: number) => {
    const info = running.get(versionId);
    if (info === undefined) {
      throw new Error(`no service worker with version ${versionId} is running`);
    } else {
      return info;
    }
  };

  const serviceWorkers = Object.assign(emitter, {
    getAllRunning: () => Object.fromEntries(running),
    getFromVersionID: getInfoFromVersionID,
    getInfoFromVersionID,
    /**
     * The engine gives the app no handle on a worker yet: no IPC with it and
     * no tasks in it.
     */
    getWorkerFromVersionID: (_versionId: number) => undefined,
    startWorkerForScope: (scope: string) =>
      Promise.reject(
        new Error(
          `Domicile's engine can't start a service worker for the app yet (${scope})`,
        ),
      ),
  });

  const heard = (event: ServiceWorkerEvent) => {
    switch (event.event) {
      case "running_status": {
        if (event.worker === undefined) {
          running.delete(event.version_id);
        } else {
          running.set(event.version_id, infoOf(event.worker));
        }
        emitter.emit("running-status-changed", {
          ...eventObject(),
          runningStatus: event.running_status,
          versionId: event.version_id,
        });
        break;
      }
      case "registration_completed":
        emitter.emit("registration-completed", eventObject(), {
          scope: event.scope,
        });
        break;
      case "console_message":
        emitter.emit("console-message", eventObject(), {
          level: event.level,
          lineNumber: event.line_number,
          message: event.message,
          source: event.source,
          sourceUrl: event.source_url,
          versionId: event.version_id,
        });
        break;
    }
  };

  return { heard, serviceWorkers };
};

const infoOf = (worker: RunningServiceWorker): ServiceWorkerInfo => ({
  renderProcessId: worker.render_process_id,
  scope: worker.scope,
  scriptUrl: worker.script_url,
  versionId: worker.version_id,
});

const eventObject = () => ({ preventDefault: () => undefined });
