import { describe, expect, it, spyOn } from "bun:test";

import { createSafeStorage, selectBackend } from "./safe-storage";

// "hello", encrypted by `openssl enc -aes-128-cbc` with the IV of sixteen
// spaces and the PBKDF2-HMAC-SHA1 keys (one round, salt "saltysalt") of
// "peanuts" and "hunter2": what Chromium's OSCrypt writes on Linux.
const HELLO_V10 = Buffer.concat([
  Buffer.from("v10"),
  Buffer.from("ce9b849d984a1cedb8ba4eea782c2680", "hex"),
]);
const HELLO_V11 = Buffer.concat([
  Buffer.from("v11"),
  Buffer.from("e1036e5bdd47ac239b10569a0ff9240c", "hex"),
]);

/** safeStorage with `password` in the keyring, counting how often it's read. */
const setUp = (
  password: string | undefined,
  backend: "basic_text" | "gnome_libsecret" = "gnome_libsecret",
) => {
  let reads = 0;
  const safeStorage = createSafeStorage({
    backend: () => backend,
    password: () => {
      reads += 1;
      return { password };
    },
  });
  return { reads: () => reads, safeStorage };
};

describe("safeStorage with a keyring", () => {
  it("decrypts what Electron encrypted, with either key", () => {
    const { safeStorage } = setUp("hunter2");

    expect(safeStorage.decryptString(HELLO_V11)).toBe("hello");
    expect(safeStorage.decryptString(HELLO_V10)).toBe("hello");
  });

  it("encrypts as Electron does, with the keyring's key", () => {
    const { safeStorage } = setUp("hunter2");

    expect(safeStorage.isEncryptionAvailable()).toBe(true);
    expect(safeStorage.encryptString("hello")).toEqual(HELLO_V11);
    expect(safeStorage.getSelectedStorageBackend()).toBe("gnome_libsecret");
  });

  it("reads the password once, and not before it's needed", () => {
    const { reads, safeStorage } = setUp("hunter2");
    expect(reads()).toBe(0);

    safeStorage.encryptString("a");
    safeStorage.decryptString(safeStorage.encryptString("b"));

    expect(reads()).toBe(1);
  });

  it("keeps any text, as UTF-8", () => {
    const { safeStorage } = setUp("hunter2");
    const text = "naïve ☕ ".repeat(10);

    expect(safeStorage.decryptString(safeStorage.encryptString(text))).toBe(
      text,
    );
  });

  it("refuses what it can't decrypt, as Electron does", () => {
    const { safeStorage } = setUp("another password");

    expect(() => safeStorage.decryptString(HELLO_V11)).toThrow(
      "Error while decrypting",
    );
    expect(() => safeStorage.decryptString(Buffer.from("hello"))).toThrow(
      "Error while decrypting",
    );
  });

  it("falls back to the empty key, as Chromium does", () => {
    const { safeStorage: empty } = setUp("");
    const { safeStorage } = setUp("hunter2");

    expect(safeStorage.decryptString(empty.encryptString("hi"))).toBe("hi");
  });
});

describe("safeStorage's async encryption", () => {
  it("encrypts and decrypts as the sync calls do", async () => {
    const { safeStorage } = setUp("hunter2");

    expect(await safeStorage.isAsyncEncryptionAvailable()).toBe(true);
    expect(await safeStorage.encryptStringAsync("hello")).toEqual(HELLO_V11);
    expect(await safeStorage.decryptStringAsync(HELLO_V11)).toEqual({
      result: "hello",
      shouldReEncrypt: false,
    });
  });

  it("asks for the keyring's key on text the hardcoded key encrypted", async () => {
    const { safeStorage } = setUp("hunter2");

    expect(await safeStorage.decryptStringAsync(HELLO_V10)).toEqual({
      result: "hello",
      shouldReEncrypt: true,
    });
  });

  it("keeps the hardcoded key's text as it is with no keyring", async () => {
    const { safeStorage } = setUp(undefined);
    safeStorage.setUsePlainTextEncryption(true);

    expect(await safeStorage.decryptStringAsync(HELLO_V10)).toEqual({
      result: "hello",
      shouldReEncrypt: false,
    });
  });

  it("rejects, as the sync calls throw", () => {
    const { safeStorage } = setUp(undefined);

    expect(safeStorage.encryptStringAsync("hello")).rejects.toThrow(
      "Encryption is not available",
    );
    expect(safeStorage.decryptStringAsync(HELLO_V11)).rejects.toThrow(
      "Error while decrypting",
    );
  });
});

describe("safeStorage without a keyring", () => {
  it("has no encryption until the app opts into plain text", () => {
    const { safeStorage } = setUp(undefined);

    expect(safeStorage.getSelectedStorageBackend()).toBe("basic_text");
    expect(safeStorage.isEncryptionAvailable()).toBe(false);
    expect(() => safeStorage.encryptString("hello")).toThrow(
      "Encryption is not available",
    );

    safeStorage.setUsePlainTextEncryption(true);
    expect(safeStorage.isEncryptionAvailable()).toBe(true);
    expect(safeStorage.encryptString("hello")).toEqual(HELLO_V10);
  });

  it("still decrypts the hardcoded key's text, but not the keyring's", () => {
    const { safeStorage } = setUp(undefined);

    expect(safeStorage.decryptString(HELLO_V10)).toBe("hello");
    expect(() => safeStorage.decryptString(HELLO_V11)).toThrow(
      "Error while decrypting",
    );
  });
});

describe("safeStorage when the keyring fails", () => {
  it("has no key and says why, rather than crash the app", () => {
    const said = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const safeStorage = createSafeStorage({
        backend: () => "gnome_libsecret",
        password: () => {
          throw new Error("the Secret Service is gone");
        },
      });

      expect(safeStorage.getSelectedStorageBackend()).toBe("basic_text");
      expect(safeStorage.isEncryptionAvailable()).toBe(false);
      expect(String(said.mock.calls[0]?.[0])).toContain(
        "the Secret Service is gone",
      );
    } finally {
      said.mockRestore();
    }
  });
});

describe("safeStorage on the plain-text backend", () => {
  it("never asks the keyring, as Chromium doesn't", () => {
    const { reads, safeStorage } = setUp("peanuts", "basic_text");

    expect(safeStorage.getSelectedStorageBackend()).toBe("basic_text");
    expect(safeStorage.isEncryptionAvailable()).toBe(false);
    expect(reads()).toBe(0);
  });
});

describe(selectBackend, () => {
  const refuse = (why: string): never => {
    throw new Error(why);
  };

  it("takes --password-store first, as Chromium does", () => {
    expect(selectBackend("basic", "GNOME", refuse)).toBe("basic_text");
    expect(selectBackend("gnome-libsecret", "domicile", refuse)).toBe(
      "gnome_libsecret",
    );
  });

  it("keeps plain text on a desktop Chromium doesn't know, as Element's own Electron did on lyra", () => {
    expect(selectBackend("", "domicile", refuse)).toBe("basic_text");
    expect(selectBackend("", undefined, refuse)).toBe("basic_text");
    expect(selectBackend("detect", "sway", refuse)).toBe("basic_text");
  });

  it("uses the keyring on the desktops Chromium does", () => {
    for (const desktop of [
      "GNOME",
      "ubuntu:GNOME",
      "XFCE",
      "X-Cinnamon",
      "Pantheon",
      "Unity",
    ]) {
      expect(selectBackend("", desktop, refuse)).toBe("gnome_libsecret");
    }
  });

  it("hands back an app that wants KWallet, which the host can't reach", () => {
    expect(() => selectBackend("kwallet5", "domicile", refuse)).toThrow(
      "KWallet",
    );
    expect(() => selectBackend("", "KDE", refuse)).toThrow("KWallet");
  });
});
