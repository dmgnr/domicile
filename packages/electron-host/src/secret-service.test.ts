import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { MessageBus } from "dbus-next";
import { sessionBus } from "dbus-next";

import { safeStoragePasswordCommand } from "./desktop";
import { startFakeDesktopBus } from "./desktop-bus-fixture";
import { readSafeStoragePassword } from "./secret-service";

describe("readSafeStoragePassword", () => {
  let desktopBus: Awaited<ReturnType<typeof startFakeDesktopBus>>;
  let bus: MessageBus;
  beforeAll(async () => {
    desktopBus = await startFakeDesktopBus({ colorScheme: 0, contrast: 0 });
    bus = sessionBus({ busAddress: desktopBus.address });
  });
  afterAll(async () => {
    bus.disconnect();
    await desktopBus.close();
  });

  it("creates the password the first time, as Chromium stores it", async () => {
    const password = await readSafeStoragePassword(bus, "Slack");

    expect(password).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(desktopBus.secrets).toEqual([
      {
        attributes: {
          application: "Slack",
          "xdg:schema": "chrome_libsecret_os_crypt_password_v2",
        },
        label: "Chromium Safe Storage",
        secret: password ?? "",
      },
    ]);
  });

  it("reads the same password back, and keeps apps apart", async () => {
    const slack = await readSafeStoragePassword(bus, "Slack");
    const element = await readSafeStoragePassword(bus, "Element");

    expect(slack).toBe(desktopBus.secrets[0]?.secret);
    expect(element).not.toBe(slack);
    expect(desktopBus.secrets).toHaveLength(2);
  });

  it("unlocks a locked keyring, through its prompt", async () => {
    desktopBus.keyring.locked = true;

    expect(await readSafeStoragePassword(bus, "Slack")).toBe(
      desktopBus.secrets[0]?.secret,
    );
    expect(desktopBus.keyring.locked).toBe(false);
  });

  it("unlocks a locked keyring to create the password there", async () => {
    // A keyring the login didn't unlock, as on lyra: the item can't be made
    // until the user unlocks it.
    desktopBus.keyring.locked = true;

    const password = await readSafeStoragePassword(bus, "Element-locked");

    expect(desktopBus.keyring.locked).toBe(false);
    expect(password).toBe(desktopBus.secrets.at(-1)?.secret);
    expect(desktopBus.secrets.at(-1)?.attributes.application).toBe(
      "Element-locked",
    );
  });

  it("has no password to create when the user won't unlock the keyring", async () => {
    desktopBus.keyring.locked = true;
    desktopBus.keyring.dismiss = true;
    try {
      expect(
        await readSafeStoragePassword(bus, "Never-unlocked"),
      ).toBeUndefined();
    } finally {
      desktopBus.keyring.locked = false;
      desktopBus.keyring.dismiss = false;
    }
  });

  it("has no password when the user won't unlock the keyring", async () => {
    desktopBus.keyring.locked = true;
    desktopBus.keyring.dismiss = true;
    try {
      expect(await readSafeStoragePassword(bus, "Slack")).toBeUndefined();
    } finally {
      desktopBus.keyring.locked = false;
      desktopBus.keyring.dismiss = false;
    }
  });

  it("is printed by its command, for the host to block on", async () => {
    const child = Bun.spawn(
      safeStoragePasswordCommand(desktopBus.address, "Slack"),
      { stderr: "inherit", stdout: "pipe" },
    );

    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      password: desktopBus.secrets[0]?.secret,
    });
    expect(await child.exited).toBe(0);
  });
});

describe("readSafeStoragePassword with no Secret Service", () => {
  it("has no password, as Electron then has no key", async () => {
    const desktopBus = await startFakeDesktopBus(
      { colorScheme: 0, contrast: 0 },
      { secretService: false },
    );
    const bus = sessionBus({ busAddress: desktopBus.address });
    try {
      expect(await readSafeStoragePassword(bus, "Slack")).toBeUndefined();
    } finally {
      bus.disconnect();
      await desktopBus.close();
    }
  });
});
