import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  useBrowserProfile,
  usePinnedSite,
  useProfileExtensions,
  useProfileMark,
} from "./useBrowserProfile";

const PERSONAL = {
  color: "#0d9488",
  configSites: [],
  enabledExtensions: [],
  extensions: [],
  id: "personal",
  isDefault: true,
  isDefaultPrivate: false,
  isPrivate: false,
  lockedExtensions: [],
  name: "Personal",
  pinnedSites: [],
};

const WORK = {
  color: "#d97706",
  configSites: [],
  enabledExtensions: [],
  extensions: [],
  id: "work",
  isDefault: false,
  isDefaultPrivate: false,
  isPrivate: false,
  lockedExtensions: [],
  name: "Work",
  pinnedSites: [],
};

describe("useBrowserProfile", () => {
  it("follows the profile a window's page is in", () => {
    const fake = new FakeDomicileHost();
    fake.set({ browserProfiles: [PERSONAL, WORK] });
    fake.domicile.browser.open("https://example.com");
    const { result } = renderHook(() => useBrowserProfile(fake.domicile, "1"));
    expect(result.current?.profile).toStrictEqual(PERSONAL);
    expect(result.current?.profiles).toStrictEqual([PERSONAL, WORK]);

    act(() => {
      fake.moveBrowser("1", "work");
    });
    expect(result.current?.profile).toStrictEqual(WORK);
  });

  it("is nothing until the engine lists the profiles", () => {
    const fake = new FakeDomicileHost();
    fake.domicile.browser.open("https://example.com");
    const { result } = renderHook(() => useBrowserProfile(fake.domicile, "1"));

    expect(result.current).toBeUndefined();
  });
});

describe("useProfileMark", () => {
  it("marks a page outside the default profile in its profile's color", () => {
    const fake = new FakeDomicileHost();
    fake.set({ browserProfiles: [PERSONAL, WORK] });
    fake.domicile.browser.open("https://example.com");
    const { result } = renderHook(() => useProfileMark(fake.domicile, "1"));
    expect(result.current).toBeUndefined();

    act(() => {
      fake.moveBrowser("1", "work");
    });
    expect(result.current).toBe("#d97706");
  });

  it("marks no window that is not the engine's", () => {
    const fake = new FakeDomicileHost();
    fake.set({ browserProfiles: [PERSONAL, WORK] });
    const { result } = renderHook(() =>
      useProfileMark(fake.domicile, undefined),
    );

    expect(result.current).toBeUndefined();
  });
});

describe("usePinnedSite", () => {
  it("says where a page's site opens, and follows a pin", async () => {
    const fake = new FakeDomicileHost();
    fake.set({ browserProfiles: [PERSONAL, WORK] });
    const { result } = renderHook(() =>
      usePinnedSite(fake.domicile, "https://news.example/story"),
    );
    await waitFor(() => {
      expect(result.current).toStrictEqual({
        locked: false,
        profile: "personal",
        site: "news.example",
      });
    });

    await act(() => fake.domicile.browser.pin("news.example", "work"));
    await waitFor(() => {
      expect(result.current).toStrictEqual({
        locked: false,
        profile: "work",
        site: "news.example",
      });
    });
  });

  it("names the config's own site, locked", async () => {
    const fake = new FakeDomicileHost();
    fake.set({
      browserProfiles: [PERSONAL, { ...WORK, configSites: ["*.acme.com"] }],
    });
    const { result } = renderHook(() =>
      usePinnedSite(fake.domicile, "https://docs.acme.com/"),
    );

    await waitFor(() => {
      expect(result.current).toStrictEqual({
        locked: true,
        profile: "work",
        site: "*.acme.com",
      });
    });
  });

  it("is nothing for a page that is no web site", () => {
    const fake = new FakeDomicileHost();
    fake.set({ browserProfiles: [PERSONAL, WORK] });
    const { result } = renderHook(() =>
      usePinnedSite(fake.domicile, "about:blank"),
    );

    expect(result.current).toBeUndefined();
  });
});

describe("useProfileExtensions", () => {
  const ICON = "data:image/png;base64,";
  const installed = (id: string, name: string) => ({
    configured: [],
    enabled: true,
    fileAccess: null,
    fromConfig: true,
    icon: ICON,
    id,
    name,
    optionsUrl: null,
    siteAccess: null,
    sites: [],
    userScripts: null,
  });

  it("names a profile's extensions and says which are on and locked", () => {
    const fake = new FakeDomicileHost();
    fake.set({
      installedExtensions: [
        installed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Bitwarden"),
        installed("oooooooooooooooooooooooooooooooo", "1Password"),
      ],
    });
    const work = {
      ...WORK,
      enabledExtensions: ["oooooooooooooooooooooooooooooooo"],
      extensions: [
        "oooooooooooooooooooooooooooooooo",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        // Not listed yet: left out until it is.
        "cccccccccccccccccccccccccccccccc",
      ],
      lockedExtensions: ["oooooooooooooooooooooooooooooooo"],
    };
    const { result } = renderHook(() =>
      useProfileExtensions(fake.domicile, work),
    );

    expect(result.current).toStrictEqual([
      {
        enabled: true,
        icon: ICON,
        id: "oooooooooooooooooooooooooooooooo",
        locked: true,
        name: "1Password",
      },
      {
        enabled: false,
        icon: ICON,
        id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        locked: false,
        name: "Bitwarden",
      },
    ]);
  });
});
