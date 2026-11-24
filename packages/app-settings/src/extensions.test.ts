import { describe, expect, it } from "bun:test";

import { hostExtensions } from "./extensions";
import { fakeHost } from "./fake-host";
import type { InstalledExtension } from "./host";

const UBLOCK: InstalledExtension = {
  description: "An efficient content blocker.",
  enabled: true,
  icon: undefined,
  id: "ddkjiahejlhfcafbddmgiahcphecmpfh",
  name: "uBlock Origin Lite",
  optionsUrl:
    "chrome-extension://ddkjiahejlhfcafbddmgiahcphecmpfh/dashboard.html",
  settings: { file_access: false },
  version: "2025.1",
};

const ZOTERO: InstalledExtension = {
  ...UBLOCK,
  id: "b".repeat(32),
  name: "zotero",
  optionsUrl: undefined,
};

/** A fake host with `installed`. */
const withInstalled = (installed: InstalledExtension[]) =>
  fakeHost({
    chosen: undefined,
    configExtensions: [],
    files: {
      config: undefined,
      evaluated: undefined,
      options: undefined,
      shell: undefined,
    },
    installed,
    media: { cameras: [], microphones: [] },
    siteData: [],
    sites: {
      defaults: {
        "automatic-downloads": "ask",
        camera: "ask",
        clipboard: "ask",
        "idle-detection": "ask",
        "local-fonts": "ask",
        location: "ask",
        microphone: "ask",
        midi: "ask",
        notifications: "ask",
        "window-management": "ask",
      },
      sites: [],
    },
  });

describe(hostExtensions, () => {
  it("lists extensions by name", async () => {
    const { host } = withInstalled([ZOTERO, UBLOCK]);
    expect(await hostExtensions(host).list()).toEqual([UBLOCK, ZOTERO]);
  });

  it("turns an extension off, and tells listeners", async () => {
    const { host, state } = withInstalled([UBLOCK]);
    const extensions = hostExtensions(host);
    const changed = new Promise<void>((resolve) => {
      extensions.onChange(resolve);
    });
    await extensions.setEnabled(UBLOCK.id, false);
    await changed;
    expect(state.installed[0]?.enabled).toBe(false);
  });

  it("changes an extension's settings, and tells listeners", async () => {
    const { host, state } = withInstalled([UBLOCK]);
    const extensions = hostExtensions(host);
    const changed = new Promise<void>((resolve) => {
      extensions.onChange(resolve);
    });
    await extensions.configure(UBLOCK.id, { file_access: true });
    await changed;
    expect(state.installed[0]?.settings).toEqual({ file_access: true });
  });

  it("opens an extension's options", async () => {
    const { host, opened } = withInstalled([UBLOCK]);
    await hostExtensions(host).openOptions(`${UBLOCK.optionsUrl}`);
    expect(opened).toEqual([`${UBLOCK.optionsUrl}`]);
  });

  it("calls a listener when the host says something changed, until it stops", async () => {
    const { change, host } = withInstalled([UBLOCK]);
    const extensions = hostExtensions(host);
    const heard: string[] = [];
    const stop = extensions.onChange(() => {
      heard.push("changed");
    });
    change();
    stop();
    change();
    await extensions.setEnabled(UBLOCK.id, false);
    expect(heard).toEqual(["changed"]);
  });
});
