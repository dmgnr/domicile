// What the host reaches on the desktop itself: commands and the session bus.
// Thin on purpose; what reads their answers is tested on its own.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageBus } from "dbus-next";
import { Message, MessageType, sessionBus, Variant } from "dbus-next";

import type { PortalSettings } from "./appearance";
import type { Ran, RunOptions } from "./electron/clipboard";
import type {
  ChooserAnswer,
  ChooserMethod,
  ChooserOptions,
} from "./electron/dialog";
import type { NotificationsBus } from "./electron/notification";
import type { SafeStoragePassword } from "./electron/safe-storage";
import type { Run } from "./electron/shell";

/** Runs `command`, answering its exit code and its output, both streams. */
export const runCommand: Run = async (command) => {
  const child = Bun.spawn([...command], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: `${out}${err}` };
};

/** `org.freedesktop.Notifications` as dbus-next's proxy calls it. */
type NotificationsProxy = {
  readonly Notify: (
    appName: string,
    replaces: number,
    icon: string,
    summary: string,
    body: string,
    actions: readonly string[],
    hints: Record<string, Variant>,
    timeout: number,
  ) => Promise<number>;
  readonly CloseNotification: (id: number) => Promise<void>;
  readonly on: NotificationsBus["on"];
};

/**
 * The desktop's services on the session bus at `address`: the settings
 * portal and the notification server, and new connections for tray icons.
 */
export const connectDesktop = async (address: string) => {
  const bus = sessionBus({ busAddress: address });
  const [portal, server] = await Promise.all([
    bus.getProxyObject(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
    ),
    bus.getProxyObject(
      "org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
    ),
  ]);
  // dbus-next types a proxy's members loosely; these are the services' own,
  // typed as the spec says.
  const settings = portal.getInterface(
    "org.freedesktop.portal.Settings",
  ) as unknown as PortalSettings;
  const notifications = server.getInterface(
    "org.freedesktop.Notifications",
  ) as unknown as NotificationsProxy;
  return {
    choose: (method: ChooserMethod, title: string, options: ChooserOptions) =>
      chooseFile(bus, method, title, options),
    chooseSync: (
      method: ChooserMethod,
      title: string,
      options: ChooserOptions,
    ) => chooseFileSync(address, method, title, options),
    /** A connection of its own, as each tray icon needs. */
    connect: () => sessionBus({ busAddress: address }),
    notifications: {
      close: (id) => notifications.CloseNotification(id),
      notify: (call) =>
        notifications.Notify(
          call.appName,
          call.replaces,
          call.icon,
          call.summary,
          call.body,
          call.actions,
          Object.fromEntries(
            Object.entries(call.hints).map(([key, [signature, value]]) => [
              key,
              new Variant(signature, value),
            ]),
          ),
          call.timeout,
        ),
      on: notifications.on.bind(notifications),
    } satisfies NotificationsBus,
    /** The app's safe storage password, read when the app first needs it. */
    safeStoragePassword: (application: string) =>
      safeStoragePasswordSync(address, application),
    settings,
  };
};

/** The connection's own bus name, once the bus has told it. */
const nameOf = async (bus: MessageBus) => {
  const named = bus as MessageBus & { name: string | null };
  if (named.name === null) {
    await new Promise((resolve) => named.once("connect", resolve));
  }
  if (named.name === null) {
    throw new Error("the session bus gave this connection no name");
  }
  return named.name;
};

const busDaemon = (member: string, rule: string) =>
  new Message({
    body: [rule],
    destination: "org.freedesktop.DBus",
    interface: "org.freedesktop.DBus",
    member,
    path: "/org/freedesktop/DBus",
    signature: "s",
  });

let tokens = 0;

/**
 * Asks the desktop's file chooser portal on `bus`, answering once the user
 * has: the response (0 for a choice) and the URIs chosen.
 */
export const chooseFile = async (
  bus: MessageBus,
  method: ChooserMethod,
  title: string,
  options: ChooserOptions,
): Promise<ChooserAnswer> => {
  tokens += 1;
  const token = `electron_host_${process.pid}_${tokens}`;
  const sender = (await nameOf(bus)).slice(1).replaceAll(".", "_");
  const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
  const rule = `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${handle}'`;
  // Listening before asking, as the spec says, so a quick answer isn't missed.
  await bus.call(busDaemon("AddMatch", rule));
  let heard: (message: Message) => void = () => undefined;
  const answered = new Promise<[number, Record<string, Variant>]>((resolve) => {
    heard = (message) => {
      if (
        message.type === MessageType.SIGNAL &&
        message.path === handle &&
        message.member === "Response"
      ) {
        resolve(message.body as [number, Record<string, Variant>]);
      }
    };
    bus.on("message", heard);
  });
  try {
    const reply = await bus.call(
      new Message({
        body: [
          "",
          title,
          Object.fromEntries([
            ...Object.entries(options).map(([key, [signature, value]]) => [
              key,
              new Variant(signature, value),
            ]),
            ["handle_token", new Variant("s", token)],
          ]),
        ],
        destination: "org.freedesktop.portal.Desktop",
        interface: "org.freedesktop.portal.FileChooser",
        member: method,
        path: "/org/freedesktop/portal/desktop",
        signature: "ssa{sv}",
      }),
    );
    const [given] = (reply?.body ?? []) as [string?];
    if (given !== handle) {
      throw new Error(
        `the file chooser portal answers at ${String(given)}, not ${handle} as the spec says`,
      );
    }
    const [response, results] = await answered;
    const uris = results.uris?.value as string[] | undefined;
    return { response, uris: uris ?? [] };
  } finally {
    bus.off("message", heard);
    await bus.call(busDaemon("RemoveMatch", rule));
  }
};

/** The command that asks the portal once and prints its answer as JSON. */
export const chooseFileCommand = (
  address: string,
  method: ChooserMethod,
  title: string,
  options: ChooserOptions,
) => [
  process.execPath,
  join(import.meta.dir, "choose-file.ts"),
  address,
  JSON.stringify({ method, options, title }),
];

/**
 * `chooseFile`, blocking until the user answers, as Electron's `Sync` dialogs
 * do: a child process asks the portal (src/choose-file.ts) while this one
 * waits on it.
 */
export const chooseFileSync = (
  address: string,
  method: ChooserMethod,
  title: string,
  options: ChooserOptions,
): ChooserAnswer => {
  const child = Bun.spawnSync(
    chooseFileCommand(address, method, title, options),
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  if (child.exitCode !== 0) {
    throw new Error(
      `asking the file chooser portal failed: ${child.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(child.stdout.toString()) as ChooserAnswer;
};

/** The command that reads `application`'s safe storage password, printing it as JSON. */
export const safeStoragePasswordCommand = (
  address: string,
  application: string,
) => [
  process.execPath,
  join(import.meta.dir, "safe-storage-password.ts"),
  address,
  application,
];

/**
 * `application`'s safe storage password, blocking until the Secret Service
 * answers, as Electron's `safeStorage` does: a child process reads it
 * (src/safe-storage-password.ts) while this one waits on it.
 */
export const safeStoragePasswordSync = (
  address: string,
  application: string,
): SafeStoragePassword => {
  const child = Bun.spawnSync(
    safeStoragePasswordCommand(address, application),
    { stderr: "pipe", stdout: "pipe" },
  );
  if (child.exitCode !== 0) {
    throw new Error(
      `reading the safe storage password from the Secret Service failed: ${child.stderr.toString().trim()}`,
    );
  }
  const { password } = JSON.parse(child.stdout.toString()) as {
    password: string | null;
  };
  return { password: password ?? undefined };
};

/**
 * Runs `command` and waits for it. Its stderr goes through a file, not a
 * pipe: a command that leaves a child running, as `wl-copy` does, would hold
 * a pipe open and this waiting.
 */
export const runCommandSync = (
  command: readonly string[],
  { input, output }: RunOptions,
): Ran => {
  const errors = join(
    tmpdir(),
    `electron-host-${process.pid}-${randomUUID()}.stderr`,
  );
  try {
    const child = Bun.spawnSync([...command], {
      stderr: Bun.file(errors),
      stdin: input ?? "ignore",
      stdout: output ? "pipe" : "ignore",
    });
    return {
      code: child.exitCode ?? 1,
      stderr: readFileSync(errors, "utf8"),
      stdout: child.stdout ?? Buffer.alloc(0),
    };
  } finally {
    rmSync(errors, { force: true });
  }
};
