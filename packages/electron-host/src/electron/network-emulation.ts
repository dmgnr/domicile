// A session's network emulation (enableNetworkEmulation), carried out in
// each of its pages by the page's DevTools client in the engine, as DevTools'
// own throttling is. A page that opens later starts with the session's.

import type { PageMethod } from "./page-control";

/** Electron's `enableNetworkEmulation` options. */
export type NetworkEmulationOptions = {
  readonly offline?: boolean;
  /** Milliseconds added to each request. */
  readonly latency?: number;
  /** Bytes per second; 0 or none is unthrottled. */
  readonly downloadThroughput?: number;
  readonly uploadThroughput?: number;
};

/** A page whose settings the engine carries out: see page-control.ts. */
type EmulatingPage = { readonly set: (method: PageMethod) => void };

/** One session's emulation, which its pages follow. */
export const createNetworkEmulation = () => {
  let emulated: NetworkEmulationOptions | undefined;
  const pages = new Set<EmulatingPage>();
  const apply = (page: EmulatingPage) => {
    page.set({
      devtools_method: "Network.emulateNetworkConditions",
      method: "devtools",
      params: devToolsConditions(emulated ?? {}),
    });
  };
  return {
    disable: () => {
      emulated = undefined;
      for (const page of pages) {
        apply(page);
      }
    },
    enable: (options: NetworkEmulationOptions) => {
      emulated = options;
      for (const page of pages) {
        apply(page);
      }
    },
    /** Applies the session's emulation to `page` until the returned stop. */
    follow: (page: EmulatingPage) => {
      pages.add(page);
      if (emulated !== undefined) {
        apply(page);
      }
      return () => {
        pages.delete(page);
      };
    },
  };
};

/** DevTools' parameters, where -1 is unthrottled. */
const devToolsConditions = (options: NetworkEmulationOptions) => ({
  downloadThroughput: throughput(options.downloadThroughput),
  latency: options.latency ?? 0,
  offline: options.offline ?? false,
  uploadThroughput: throughput(options.uploadThroughput),
});

const throughput = (bytesPerSecond: number | undefined) =>
  bytesPerSecond === undefined || bytesPerSecond <= 0 ? -1 : bytesPerSecond;
