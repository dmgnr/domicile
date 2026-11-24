// The stand-ins for Electron's `contentTracing` and `netLog`. Tracing and
// network logs are the engine's, not the app's, so a recording holds
// nothing: it starts, stops and answers with an empty file.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const createContentTracing = (temp: () => string) => {
  let recording = false;
  return {
    // A heap profile goes in a trace, and the engine's traces aren't the app's.
    enableHeapProfiling: () => Promise.resolve(),
    getCategories: async () => [] as string[],
    getTraceBufferUsage: async () => ({ percentage: 0, value: 0 }),
    get recording() {
      return recording;
    },
    startRecording: (_options: unknown) => {
      recording = true;
      return Promise.resolve();
    },
    stopRecording: async (path?: string) => {
      recording = false;
      const out = path ?? join(temp(), `trace-${Date.now()}.json`);
      await writeFile(out, JSON.stringify({ traceEvents: [] }));
      return out;
    },
  };
};

export const createNetLog = () => {
  let logging: string | undefined;
  return {
    get currentlyLogging() {
      return logging !== undefined;
    },
    startLogging: async (path: string, _options?: unknown) => {
      logging = path;
      await writeFile(path, JSON.stringify({ constants: {}, events: [] }));
    },
    stopLogging: () => {
      logging = undefined;
      return Promise.resolve();
    },
  };
};
