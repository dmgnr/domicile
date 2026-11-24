// The app's safe storage password in the Secret Service, as Chromium's
// libsecret key storage keeps it: an item labeled "Chromium Safe Storage"
// with the `chrome_libsecret_os_crypt_password_v2` schema and `application`
// set to the app's name, holding 16 random bytes in base64. Electron finds
// the same item, so either one reads what the other wrote.

import { randomBytes } from "node:crypto";

import type { MessageBus } from "dbus-next";
import { Message, MessageType, Variant } from "dbus-next";

const SECRETS = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";
const DEFAULT_COLLECTION = "/org/freedesktop/secrets/aliases/default";
const SCHEMA = "chrome_libsecret_os_crypt_password_v2";
const LABEL = "Chromium Safe Storage";

/** Calls `member` and answers its reply's body. */
const call = async (
  bus: MessageBus,
  destination: string,
  path: string,
  iface: string,
  member: string,
  signature: string,
  body: unknown[],
) => {
  const reply = await bus.call(
    new Message({
      body,
      destination,
      interface: iface,
      member,
      path,
      signature,
    }),
  );
  return (reply?.body ?? []) as unknown[];
};

const busDaemon = (bus: MessageBus, member: string, body: unknown[]) =>
  call(
    bus,
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
    member,
    body.length === 0 ? "" : "s",
    body,
  );

/** Whether `why` is the Secret Service refusing a locked collection. */
const isLocked = (why: unknown) =>
  why instanceof Error &&
  (why as Error & { type?: string }).type ===
    "org.freedesktop.Secret.Error.IsLocked";

/** Whether a Secret Service runs on `bus`, or would start when asked. */
const hasSecretService = async (bus: MessageBus) => {
  const [running] = await busDaemon(bus, "NameHasOwner", [SECRETS]);
  if (running === true) {
    return true;
  }
  const [activatable] = await busDaemon(bus, "ListActivatableNames", []);
  return (activatable as string[]).includes(SECRETS);
};

/**
 * Shows the Secret Service's prompt at `path`, if there's one, answering
 * whether the user went through with it.
 */
const prompted = async (bus: MessageBus, path: string) => {
  if (path === "/") {
    return true;
  }
  const rule = `type='signal',interface='org.freedesktop.Secret.Prompt',member='Completed',path='${path}'`;
  await busDaemon(bus, "AddMatch", [rule]);
  let heard: (message: Message) => void = () => undefined;
  const completed = new Promise<boolean>((resolve) => {
    heard = (message) => {
      if (
        message.type === MessageType.SIGNAL &&
        message.path === path &&
        message.member === "Completed"
      ) {
        resolve(message.body[0] !== true);
      }
    };
    bus.on("message", heard);
  });
  try {
    await call(
      bus,
      SECRETS,
      path,
      "org.freedesktop.Secret.Prompt",
      "Prompt",
      "s",
      [""],
    );
    return await completed;
  } finally {
    bus.off("message", heard);
    await busDaemon(bus, "RemoveMatch", [rule]);
  }
};

/**
 * The safe storage password for `application`, created the first time; or
 * undefined when there's no Secret Service, or the user wouldn't unlock it,
 * as Electron then has no key.
 */
export const readSafeStoragePassword = async (
  bus: MessageBus,
  application: string,
): Promise<string | undefined> => {
  if (!(await hasSecretService(bus))) {
    return undefined;
  }
  const service = (member: string, signature: string, body: unknown[]) =>
    call(
      bus,
      SECRETS,
      SERVICE_PATH,
      "org.freedesktop.Secret.Service",
      member,
      signature,
      body,
    );
  // Plain: the secret crosses the session bus only, as libsecret's does.
  const [, session] = (await service("OpenSession", "sv", [
    "plain",
    new Variant("s", ""),
  ])) as [Variant, string];
  try {
    const [unlocked, locked] = (await service("SearchItems", "a{ss}", [
      { application },
    ])) as [string[], string[]];
    let items = unlocked;
    if (items.length === 0 && locked.length > 0) {
      const [opened, prompt] = (await service("Unlock", "ao", [locked])) as [
        string[],
        string,
      ];
      if (!(await prompted(bus, prompt))) {
        return undefined;
      }
      items = opened.length > 0 ? opened : locked;
    }
    const [first] = items;
    if (first !== undefined) {
      const [secrets] = (await service("GetSecrets", "aoo", [
        [first],
        session,
      ])) as [Record<string, [string, Buffer, Buffer, string]>];
      const secret = secrets[first];
      if (secret === undefined) {
        throw new Error(`the Secret Service gave no secret for ${first}`);
      }
      return Buffer.from(secret[2]).toString("utf8");
    }
    const password = randomBytes(16).toString("base64");
    const create = () =>
      call(
        bus,
        SECRETS,
        DEFAULT_COLLECTION,
        "org.freedesktop.Secret.Collection",
        "CreateItem",
        "a{sv}(oayays)b",
        [
          {
            "org.freedesktop.Secret.Item.Attributes": new Variant("a{ss}", {
              application,
              "xdg:schema": SCHEMA,
            }),
            "org.freedesktop.Secret.Item.Label": new Variant("s", LABEL),
          },
          [session, Buffer.alloc(0), Buffer.from(password), "text/plain"],
          false,
        ],
      ) as Promise<[string, string]>;
    let created: [string, string];
    try {
      created = await create();
    } catch (why) {
      if (!isLocked(why)) {
        throw why;
      }
      // A keyring the login didn't unlock: unlock it through its prompt, as
      // libsecret does for Electron, then make the item.
      const [collection] = (await service("ReadAlias", "s", ["default"])) as [
        string,
      ];
      const [, prompt] = (await service("Unlock", "ao", [
        [collection === "/" ? DEFAULT_COLLECTION : collection],
      ])) as [string[], string];
      if (!(await prompted(bus, prompt))) {
        return undefined;
      }
      created = await create();
    }
    return (await prompted(bus, created[1])) ? password : undefined;
  } finally {
    await call(
      bus,
      SECRETS,
      session,
      "org.freedesktop.Secret.Session",
      "Close",
      "",
      [],
    );
  }
};
