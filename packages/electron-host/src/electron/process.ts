// What Electron adds to the main process's `process`: its type, versions and
// resources, and its calls for the system and this process's own use.

import { freemem, release, totalmem } from "node:os";
import { getHeapStatistics as v8Heap, writeHeapSnapshot } from "node:v8";

const kilobytes = (bytes: number) => Math.round(bytes / 1024);

let lastUsage = process.cpuUsage();
let lastTime = process.hrtime.bigint();

export const electronProcess = (resourcesPath: string) => ({
  contextIsolated: false,
  crash: () => {
    process.abort();
  },
  getBlinkMemoryInfo: () => ({ allocated: 0, total: 0 }),
  /** Since the last call, as Electron measures it. */
  getCPUUsage: () => {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage(lastUsage);
    const elapsed = Number(now - lastTime) / 1000;
    lastUsage = process.cpuUsage();
    lastTime = now;
    return {
      idleWakeupsPerSecond: 0,
      percentCPUUsage:
        elapsed === 0 ? 0 : ((usage.user + usage.system) / elapsed) * 100,
    };
  },
  getCreationTime: () => Date.now() - Math.round(process.uptime() * 1000),
  getHeapStatistics: () => {
    const heap = v8Heap();
    return {
      doesZapGarbage: false,
      heapSizeLimit: kilobytes(heap.heap_size_limit),
      mallocedMemory: kilobytes(heap.malloced_memory),
      peakMallocedMemory: kilobytes(heap.peak_malloced_memory),
      totalAvailableSize: kilobytes(heap.total_available_size),
      totalHeapSize: kilobytes(heap.total_heap_size),
      totalHeapSizeExecutable: kilobytes(heap.total_heap_size_executable),
      totalPhysicalSize: kilobytes(heap.total_physical_size),
      usedHeapSize: kilobytes(heap.used_heap_size),
    };
  },
  getProcessMemoryInfo: () => {
    const { rss } = process.memoryUsage();
    return Promise.resolve({
      private: kilobytes(rss),
      residentSet: kilobytes(rss),
      shared: 0,
    });
  },
  getSystemMemoryInfo: () => ({
    free: kilobytes(freemem()),
    swapFree: 0,
    swapTotal: 0,
    total: kilobytes(totalmem()),
  }),
  /** The kernel's version, as Chromium reports Linux's. */
  getSystemVersion: () => release(),
  hang: () => {
    for (;;) {
      // As Electron's: the process stops answering.
    }
  },
  noAsar: false,
  resourcesPath,
  sandboxed: false,
  setFdLimit: (_limit: number) => undefined,
  takeHeapSnapshot: (path: string) => {
    try {
      writeHeapSnapshot(path);
      return true;
    } catch {
      return false;
    }
  },
  type: "browser",
});
