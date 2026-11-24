import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, renderHook } from "@testing-library/react";

import { useInstalledExtensions } from "./useInstalledExtensions";

const darkReader = {
  configured: [],
  enabled: true,
  fileAccess: null,
  fromConfig: false,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Dark Reader",
  optionsUrl: null,
  siteAccess: null,
  sites: [],
  userScripts: null,
};

describe("useInstalledExtensions", () => {
  it("has none until the engine has said", () => {
    const fake = new FakeDomicileHost();

    const { result } = renderHook(() => useInstalledExtensions(fake.domicile));

    expect(result.current).toStrictEqual([]);
  });

  it("is the list last said", () => {
    const fake = new FakeDomicileHost();
    const { result } = renderHook(() => useInstalledExtensions(fake.domicile));

    act(() => {
      fake.set({ installedExtensions: [darkReader] });
    });

    expect(result.current.map(({ name }) => name)).toStrictEqual([
      "Dark Reader",
    ]);
  });
});
