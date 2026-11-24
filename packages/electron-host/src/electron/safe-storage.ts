// The stand-in for Electron's `safeStorage`: Chromium's OSCrypt for Linux,
// byte for byte, so what an app encrypted while it ran on its own Electron
// still decrypts here, and the other way round.
//
// The key comes from a password the Secret Service keeps for the app
// ("Chromium Safe Storage", `application` set to the app's name), as
// Electron's comes. With no Secret Service, Electron's backend is
// `basic_text`, and encryption is only there once the app opts into its
// hardcoded password with `setUsePlainTextEncryption`.

import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { Priority, say } from "../journal";

/** The app's Secret Service password, or none when there's no Secret Service. */
export type SafeStoragePassword = { readonly password: string | undefined };

/** The backends the host can keep a key in, as Electron names them. */
export type SafeStorageBackend = "basic_text" | "gnome_libsecret";

/** Desktops on which Chromium keeps its key in the Secret Service. */
const LIBSECRET_DESKTOPS = new Set([
  "cinnamon",
  "deepin",
  "gnome",
  "pantheon",
  "ukui",
  "unity",
  "x-cinnamon",
  "xfce",
]);

/**
 * The backend Chromium's key storage picks: `--password-store` first, else
 * by desktop, and plain text on one it doesn't know (as Domicile is), as the
 * app's own Electron would have. An app reading what it stored there must
 * find the same backend, or it migrates and relaunches without end, as
 * Element did. KWallet, which the host can't reach, hands the app back.
 */
export const selectBackend = (
  passwordStore: string,
  currentDesktop: string | undefined,
  refuse: (why: string) => never,
): SafeStorageBackend => {
  const kwallet = () =>
    refuse(
      "it keeps its key in KWallet, which Domicile's Electron can't reach yet",
    );
  switch (passwordStore) {
    case "basic":
      return "basic_text";
    case "gnome":
    case "gnome-keyring":
    case "gnome-libsecret":
      return "gnome_libsecret";
    case "kwallet":
    case "kwallet5":
    case "kwallet6":
      return kwallet();
    default: {
      const desktops = (currentDesktop ?? "")
        .split(":")
        .map((desktop) => desktop.toLowerCase());
      if (desktops.includes("kde")) {
        return kwallet();
      }
      return desktops.some((desktop) => LIBSECRET_DESKTOPS.has(desktop))
        ? "gnome_libsecret"
        : "basic_text";
    }
  }
};

export type SafeStorageDependencies = {
  /** The backend Chromium would pick, read when the app first needs it. */
  readonly backend: () => SafeStorageBackend;
  /**
   * Reads the password, creating it the first time, blocking as Electron
   * does: it may ask the user to unlock their keyring. Called once, when
   * the app first needs it.
   */
  readonly password: () => SafeStoragePassword;
};

/** OSCrypt's key for `password`: PBKDF2-HMAC-SHA1, one round, "saltysalt". */
const keyOf = (password: string) =>
  pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");

/** Sixteen spaces, OSCrypt's IV. */
const IV = Buffer.alloc(16, " ");

/** The hardcoded password Chromium's `basic_text` backend uses. */
const V10_KEY = keyOf("peanuts");

/** The empty password Chromium also tries, for data from a keyring bug. */
const EMPTY_KEY = keyOf("");

const encrypt = (key: Buffer, prefix: string, text: string) => {
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
};

/** `ciphertext` decrypted with `key`, or undefined when it isn't its key. */
const decrypt = (key: Buffer, ciphertext: Buffer) => {
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key shows as bad padding: the caller tries the next key, then
    // throws as Electron does.
    return undefined;
  }
};

/**
 * The app's password, or none when the Secret Service fails, as Electron then
 * has no key: the app goes on, without encryption, rather than crash. Said on
 * stderr, as the failure is the desktop's keyring's, not the app's.
 */
const readPassword = (
  dependencies: SafeStorageDependencies,
): SafeStoragePassword => {
  try {
    return dependencies.password();
  } catch (why) {
    // The desktop's keyring failed, which only the log can say.
    say(
      Priority.Error,
      `electron-host: safeStorage has no key, as reading it failed: ${why instanceof Error ? why.message : String(why)}`,
    );
    return { password: undefined };
  }
};

/** Builds Electron's `safeStorage` for one app. */
export const createSafeStorage = (dependencies: SafeStorageDependencies) => {
  let password: SafeStoragePassword | undefined;
  let usePlainText = false;
  let backend: SafeStorageBackend | undefined;
  const keyring = () => {
    backend ??= dependencies.backend();
    if (backend === "basic_text") {
      return undefined;
    }
    password ??= readPassword(dependencies);
    return password.password === undefined
      ? undefined
      : keyOf(password.password);
  };

  const isEncryptionAvailable = () => keyring() !== undefined || usePlainText;

  const decryptString = (encrypted: Buffer) => {
    if (!Buffer.isBuffer(encrypted)) {
      throw new TypeError(
        "Expected the first argument of decryptString() to be a buffer",
      );
    }
    const prefix = encrypted.subarray(0, 3).toString("latin1");
    const body = encrypted.subarray(3);
    const key = prefix === "v11" ? keyring() : V10_KEY;
    const plain =
      (prefix === "v10" || prefix === "v11") && key !== undefined
        ? (decrypt(key, body) ?? decrypt(EMPTY_KEY, body))
        : undefined;
    if (plain === undefined) {
      throw new Error(
        "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
      );
    }
    return plain;
  };

  const encryptString = (plainText: string) => {
    const key = keyring();
    if (key !== undefined) {
      return encrypt(key, "v11", plainText);
    } else if (usePlainText) {
      return encrypt(V10_KEY, "v10", plainText);
    } else {
      throw new Error(
        "Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.",
      );
    }
  };

  return {
    decryptString,

    /**
     * Decrypts as `decryptString`, saying whether to encrypt it again: text
     * the hardcoded key encrypted once the keyring has a key, as Chromium's
     * async OSCrypt says of data under a key that isn't its default.
     */
    decryptStringAsync: async (encrypted: Buffer) => ({
      result: decryptString(encrypted),
      shouldReEncrypt:
        encrypted.subarray(0, 3).toString("latin1") === "v10" &&
        keyring() !== undefined,
    }),

    encryptString,

    encryptStringAsync: async (plainText: string) => encryptString(plainText),

    /** Electron's name for where the key is kept. */
    getSelectedStorageBackend: () =>
      keyring() === undefined ? "basic_text" : "gnome_libsecret",

    isAsyncEncryptionAvailable: () => Promise.resolve(isEncryptionAvailable()),

    isEncryptionAvailable,

    setUsePlainTextEncryption: (use: boolean) => {
      usePlainText = use;
    },
  };
};
