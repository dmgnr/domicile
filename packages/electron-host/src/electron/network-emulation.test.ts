import { describe, expect, it } from "bun:test";

import { createNetworkEmulation } from "./network-emulation";
import type { PageMethod } from "./page-control";

const page = () => {
  const set: PageMethod[] = [];
  return { set, target: { set: (method: PageMethod) => set.push(method) } };
};

const emulating = (params: Record<string, unknown>): PageMethod => ({
  devtools_method: "Network.emulateNetworkConditions",
  method: "devtools",
  params,
});

describe(createNetworkEmulation, () => {
  it("emulates a session's conditions in each of its pages, those opened later included, until it stops", () => {
    const emulation = createNetworkEmulation();
    const first = page();
    emulation.follow(first.target);

    emulation.enable({ downloadThroughput: 6400, latency: 500 });
    const later = page();
    emulation.follow(later.target);
    emulation.disable();

    const slow = emulating({
      downloadThroughput: 6400,
      latency: 500,
      offline: false,
      uploadThroughput: -1,
    });
    const none = emulating({
      downloadThroughput: -1,
      latency: 0,
      offline: false,
      uploadThroughput: -1,
    });
    expect(first.set).toEqual([slow, none]);
    expect(later.set).toEqual([slow, none]);
  });

  it("leaves a page alone that opens while nothing is emulated, and one that stopped following", () => {
    const emulation = createNetworkEmulation();
    const quiet = page();
    const gone = page();
    emulation.follow(quiet.target);
    const stop = emulation.follow(gone.target);

    stop();
    emulation.enable({ offline: true });

    expect(quiet.set).toEqual([
      emulating({
        downloadThroughput: -1,
        latency: 0,
        offline: true,
        uploadThroughput: -1,
      }),
    ]);
    expect(gone.set).toEqual([]);
  });
});
