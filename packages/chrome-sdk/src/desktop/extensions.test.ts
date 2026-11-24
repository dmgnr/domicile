import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { desktop } from "./desktop";

const action = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,AA==",
  id: "abcdefghijklmnopabcdefghijklmnop",
  name: "Dark Reader",
  popup: null,
  profile: "default",
  title: "Dark Reader",
};

const installed = {
  configured: ["fileAccess" as const],
  enabled: false,
  fileAccess: false,
  fromConfig: true,
  icon: "data:image/png;base64,AA==",
  id: "abcdefghijklmnopabcdefghijklmnop",
  name: "Dark Reader",
  optionsUrl: null,
  siteAccess: "specific_sites" as const,
  sites: ["github.com"],
  userScripts: null,
};

describe("extensions", () => {
  it("lists nothing until the engine says", () => {
    expect(
      desktop(new FakeDomicileHost().host).extensions.list,
    ).toBeUndefined();
  });

  it("lists each action, with undefined for no popup", () => {
    const fake = new FakeDomicileHost();
    fake.set({ extensions: [action] });

    expect(desktop(fake.host).extensions.list).toStrictEqual([
      { ...action, popup: undefined },
    ]);
  });

  it("throws on an action it cannot draw", () => {
    const fake = new FakeDomicileHost();
    fake.set({ extensions: [{ ...action, id: "not-an-id" }] });

    expect(() => desktop(fake.host).extensions.list).toThrow();
  });

  it("clicks an action", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host).extensions.activate(action.id);

    expect(fake.calls).toStrictEqual([["activateExtension", action.id]]);
  });

  it("says the actions changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).extensions.on("change", () => {
        resolve(undefined);
      });
    });
    fake.set({ extensions: [] });

    expect(await changed).toBeUndefined();
  });

  it("passes on an extension's request for its popup", async () => {
    const fake = new FakeDomicileHost();
    const asked = new Promise((resolve) => {
      desktop(fake.host).extensions.on("popup", resolve);
    });
    fake.dispatch("extensionpopuprequested", {
      extensionId: action.id,
      popup: `chrome-extension://${action.id}/popup.html`,
      profile: "work",
    });

    expect(await asked).toStrictEqual({
      id: action.id,
      popup: `chrome-extension://${action.id}/popup.html`,
      profile: "work",
    });
  });

  it("shows a profile's actions", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host).extensions.setProfile("work");

    expect(fake.calls).toStrictEqual([["setExtensionsProfile", "work"]]);
  });

  describe("installed", () => {
    it("lists nothing until the engine says", () => {
      expect(
        desktop(new FakeDomicileHost().host).extensions.installed,
      ).toBeUndefined();
    });

    it("lists each extension, with undefined for each setting it cannot use", () => {
      const fake = new FakeDomicileHost();
      fake.set({ installedExtensions: [installed] });

      expect(desktop(fake.host).extensions.installed).toStrictEqual([
        {
          ...installed,
          optionsUrl: undefined,
          userScripts: undefined,
        },
      ]);
    });

    it("throws on a site access it does not know", () => {
      const fake = new FakeDomicileHost();
      fake.set({
        installedExtensions: [{ ...installed, siteAccess: "sometimes" }],
      });

      expect(() => desktop(fake.host).extensions.installed).toThrow();
    });

    it("says the installed extensions changed", async () => {
      const fake = new FakeDomicileHost();
      const changed = new Promise((resolve) => {
        desktop(fake.host).extensions.on("installed", () => {
          resolve(undefined);
        });
      });
      fake.set({ installedExtensions: [] });

      expect(await changed).toBeUndefined();
    });

    it("switches, configures and uninstalls an extension", () => {
      const fake = new FakeDomicileHost();
      const { extensions } = desktop(fake.host);
      extensions.setEnabled(installed.id, false).catch(() => undefined);
      extensions
        .configure(installed.id, { siteAccess: "on_click" })
        .catch(() => undefined);
      extensions.uninstall(installed.id).catch(() => undefined);

      expect(fake.calls).toStrictEqual([
        ["setExtensionEnabled", installed.id, false],
        ["configureExtension", installed.id, { siteAccess: "on_click" }],
        ["uninstallExtension", installed.id],
      ]);
    });
  });
});
