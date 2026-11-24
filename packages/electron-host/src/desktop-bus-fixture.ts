// A desktop session bus for tests: a private dbus-daemon serving a stand-in
// settings portal with the appearance a test gives, and a notification server
// that writes down each notification, and a tray watcher that writes down
// each item registered with it, and a file chooser portal that answers what a
// test tells it to, and, unless a test says there's none, a Secret Service
// that keeps its items in memory, never locked, and logind's manager, whose
// sleep and shutdown signals a test sends.

import type { MessageBus } from "dbus-next";
import {
  DBusError,
  interface as dbusInterface,
  Message,
  sessionBus,
  Variant,
} from "dbus-next";

/**
 * The portal's `org.freedesktop.appearance` values. No `accentColor` is the
 * spec's out-of-range accent, which means none.
 */
export type PortalAppearance = {
  colorScheme: number;
  contrast: number;
  accentColor?: [number, number, number];
};

/** A notification the server was sent: its summary, body and hints' values. */
export type SentNotification = {
  appName: string;
  summary: string;
  body: string;
  actions: string[];
  hints: Record<string, unknown>;
};

class Settings extends dbusInterface.Interface {
  constructor(private readonly appearance: PortalAppearance) {
    super("org.freedesktop.portal.Settings");
  }

  ReadOne(namespace: string, key: string) {
    if (namespace === "org.freedesktop.appearance" && key === "color-scheme") {
      return new Variant("u", this.appearance.colorScheme);
    } else if (
      namespace === "org.freedesktop.appearance" &&
      key === "contrast"
    ) {
      return new Variant("u", this.appearance.contrast);
    } else if (
      namespace === "org.freedesktop.appearance" &&
      key === "accent-color"
    ) {
      return new Variant("(ddd)", this.appearance.accentColor ?? [-1, -1, -1]);
    } else {
      throw new DBusError(
        "org.freedesktop.portal.Error.NotFound",
        `no ${namespace} ${key}`,
      );
    }
  }
}

Settings.configureMembers({
  methods: { ReadOne: { inSignature: "ss", outSignature: "v" } },
  signals: { SettingChanged: { signature: "ssv" } },
});

class LoginManager extends dbusInterface.Interface {
  constructor() {
    super("org.freedesktop.login1.Manager");
  }

  PrepareForSleep(start: boolean) {
    return start;
  }

  PrepareForShutdown(start: boolean) {
    return start;
  }
}

LoginManager.configureMembers({
  signals: {
    PrepareForShutdown: { signature: "b" },
    PrepareForSleep: { signature: "b" },
  },
});

class Notifications extends dbusInterface.Interface {
  readonly sent: SentNotification[] = [];

  constructor() {
    super("org.freedesktop.Notifications");
  }

  Notify(
    appName: string,
    _replaces: number,
    _icon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Record<string, Variant>,
    _timeout: number,
  ) {
    this.sent.push({
      actions,
      appName,
      body,
      hints: Object.fromEntries(
        Object.entries(hints).map(([key, { value }]) => [key, value]),
      ),
      summary,
    });
    return this.sent.length;
  }

  CloseNotification(_id: number) {
    // Nothing to take down: nothing is drawn.
  }
}

Notifications.configureMembers({
  methods: {
    CloseNotification: { inSignature: "u", outSignature: "" },
    Notify: { inSignature: "susssasa{sv}i", outSignature: "u" },
  },
  signals: {
    ActionInvoked: { signature: "us" },
    NotificationClosed: { signature: "uu" },
    NotificationReplied: { signature: "us" },
  },
});

/** An item registered with the tray: what it said, and its connection. */
export type RegisteredItem = { service: string; sender: string };

/** A file chooser portal call: its method, title and options' values. */
export type AskedChooser = {
  method: string;
  title: string;
  options: Record<string, unknown>;
};

/** Starts the bus and its services; `address` goes in DBUS_SESSION_BUS_ADDRESS. */
const ITEMS = "/org/freedesktop/secrets/collection/login/";
const PROMPT = "/org/freedesktop/secrets/prompt/1";

/** Whether the fake keyring is locked, and whether its prompt is dismissed. */
export type KeyringState = { locked: boolean; dismiss: boolean };

/** Answers the Secret Service calls Chromium's key storage makes. */
const serveSecrets = (
  bus: MessageBus,
  secrets: StoredSecret[],
  keyring: KeyringState,
) => {
  const reply = (message: Message, signature: string, body: unknown[]) => {
    bus.send(Message.newMethodReturn(message, signature, body));
    return true;
  };
  const pathOf = (index: number) => `${ITEMS}${index}`;
  bus.addMethodHandler((message: Message) => {
    const body = message.body as unknown[];
    switch (`${message.interface}.${message.member}`) {
      case "org.freedesktop.Secret.Service.OpenSession":
        return reply(message, "vo", [
          new Variant("s", ""),
          "/org/freedesktop/secrets/session/1",
        ]);
      case "org.freedesktop.Secret.Session.Close":
        return reply(message, "", []);
      case "org.freedesktop.Secret.Service.SearchItems": {
        const wanted = body[0] as Record<string, string>;
        const found = secrets.flatMap((item, index) =>
          Object.entries(wanted).every(
            ([key, value]) => item.attributes[key] === value,
          )
            ? [pathOf(index)]
            : [],
        );
        return reply(
          message,
          "aoao",
          keyring.locked ? [[], found] : [found, []],
        );
      }
      case "org.freedesktop.Secret.Service.Unlock":
        return reply(message, "aoo", [[], PROMPT]);
      case "org.freedesktop.Secret.Prompt.Prompt": {
        reply(message, "", []);
        if (!keyring.dismiss) {
          keyring.locked = false;
        }
        bus.send(
          Message.newSignal(
            PROMPT,
            "org.freedesktop.Secret.Prompt",
            "Completed",
            "bv",
            [keyring.dismiss, new Variant("ao", [])],
          ),
        );
        return true;
      }
      case "org.freedesktop.Secret.Service.GetSecrets": {
        const [paths, session] = body as [string[], string];
        return reply(message, "a{o(oayays)}", [
          Object.fromEntries(
            paths.map((path) => [
              path,
              [
                session,
                Buffer.alloc(0),
                Buffer.from(
                  secrets[Number(path.slice(ITEMS.length))]?.secret ?? "",
                ),
                "text/plain",
              ],
            ]),
          ),
        ]);
      }
      case "org.freedesktop.Secret.Service.ReadAlias":
        return reply(message, "o", [
          body[0] === "default" ? ITEMS.slice(0, -1) : "/",
        ]);
      case "org.freedesktop.Secret.Collection.CreateItem": {
        if (keyring.locked) {
          // As gnome-keyring answers a locked login keyring.
          // dbus-next's typings call the message replied to a string.
          bus.send(
            Message.newError(
              message as unknown as string,
              "org.freedesktop.Secret.Error.IsLocked",
              "Cannot create an item in a locked collection",
            ),
          );
          return true;
        }
        const [properties, [, , value]] = body as [
          Record<string, Variant>,
          [string, Buffer, Buffer, string],
        ];
        secrets.push({
          attributes: properties["org.freedesktop.Secret.Item.Attributes"]
            ?.value as Record<string, string>,
          label: String(properties["org.freedesktop.Secret.Item.Label"]?.value),
          secret: Buffer.from(value).toString("utf8"),
        });
        return reply(message, "oo", [pathOf(secrets.length - 1), "/"]);
      }
      default:
        return false;
    }
  });
};

/** An item in the fake Secret Service. */
export type StoredSecret = {
  label: string;
  attributes: Record<string, string>;
  secret: string;
};

export const startFakeDesktopBus = async (
  appearance: PortalAppearance,
  { secretService = true }: { secretService?: boolean } = {},
) => {
  const daemon = Bun.spawn(
    ["dbus-daemon", "--session", "--nofork", "--print-address=1"],
    { stderr: "inherit", stdin: "ignore", stdout: "pipe" },
  );
  const reader = daemon.stdout.getReader();
  let printed = "";
  while (!printed.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("test: dbus-daemon exited before printing its address");
    }
    printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const address = printed.trim();
  const bus = sessionBus({ busAddress: address });
  await bus.requestName("org.freedesktop.portal.Desktop", 0);
  await bus.requestName("org.freedesktop.Notifications", 0);
  await bus.requestName("org.kde.StatusNotifierWatcher", 0);
  await bus.requestName("org.freedesktop.login1", 0);
  const registered: RegisteredItem[] = [];
  // By hand rather than as an interface: the item's connection is the
  // message's sender, which an interface's method isn't told.
  bus.addMethodHandler((message: Message) => {
    if (
      message.interface !== "org.kde.StatusNotifierWatcher" ||
      message.member !== "RegisterStatusNotifierItem"
    ) {
      return false;
    }
    registered.push({
      sender: message.sender ?? "",
      service: String(message.body[0]),
    });
    bus.send(Message.newMethodReturn(message));
    return true;
  });
  const secrets: StoredSecret[] = [];
  const keyring: KeyringState = { dismiss: false, locked: false };
  if (secretService) {
    await bus.requestName("org.freedesktop.secrets", 0);
    serveSecrets(bus, secrets, keyring);
  }
  const chooser = {
    /** What the portal answers next: a response, and the URIs chosen. */
    answer: { response: 0, uris: [] as string[] },
    asked: [] as AskedChooser[],
  };
  bus.addMethodHandler((message: Message) => {
    if (message.interface !== "org.freedesktop.portal.FileChooser") {
      return false;
    }
    const [, title, options] = message.body as [
      string,
      string,
      Record<string, Variant>,
    ];
    chooser.asked.push({
      method: message.member ?? "",
      options: Object.fromEntries(
        Object.entries(options).map(([key, { value }]) => [key, value]),
      ),
      title,
    });
    const token = String(options.handle_token?.value);
    const sender = (message.sender ?? "").slice(1).replaceAll(".", "_");
    const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
    bus.send(Message.newMethodReturn(message, "o", [handle]));
    const { response, uris } = chooser.answer;
    bus.send(
      Message.newSignal(
        handle,
        "org.freedesktop.portal.Request",
        "Response",
        "ua{sv}",
        [response, { uris: new Variant("as", uris) }],
      ),
    );
    return true;
  });
  const notifications = new Notifications();
  bus.export("/org/freedesktop/portal/desktop", new Settings(appearance));
  bus.export("/org/freedesktop/Notifications", notifications);
  const logind = new LoginManager();
  bus.export("/org/freedesktop/login1", logind);
  return {
    address,
    /** The file chooser portal: what it was asked, and what it answers. */
    chooser,
    close: async () => {
      bus.disconnect();
      daemon.kill();
      await daemon.exited;
    },
    /** Whether the keyring is locked, and what its unlock prompt does. */
    keyring,
    /** logind's manager, to send its signals. */
    logind,
    /** Each notification the server was sent, in order. */
    notifications: notifications.sent,
    /** Each item registered with the tray, in order. */
    registered,
    /** The Secret Service's items. */
    secrets,
  };
};
