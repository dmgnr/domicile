// New mail as desktop notifications, sent to the notification server the
// compositor runs. See docs/architecture/NOTIFICATIONS.md.

import type { Dbus } from "@domicile-desktop/sdk/desktop/dbus";
import type {
  DbusSignal,
  Listened,
  Listening,
} from "@domicile-desktop/sdk/system";
import { Bus, ListenedKind } from "@domicile-desktop/sdk/system";
import type { Favicons } from "@domicile-desktop/system-apps/favicons";
import { z } from "zod";

import { inboxAddress } from "./addresses";
import type { Mail, MailNews } from "./gmail-api";
import type { MailBrowser } from "./open-mail";
import { openMail } from "./open-mail";

/** The notification server's address on the session bus. */
const SERVER = {
  bus: Bus.Session,
  destination: "org.freedesktop.Notifications",
  interface: "org.freedesktop.Notifications",
  path: "/org/freedesktop/Notifications",
};

/** The most messages notified one by one. More become one notification. */
const MOST_APART = 3;

/** The most senders a notification for many messages names. */
const MOST_NAMED = 3;

/** What notifies: the bus, and the browser a press opens Gmail in. */
export type NoticeDesk = {
  readonly dbus: Pick<Dbus, "call" | "match">;
  readonly browser: MailBrowser;
};

/** The account mail arrived for. */
/**
 * An account whose mail is notified, and the browser profile its Gmail
 * window opens in: its site's, as the engine routes it, when `undefined`.
 */
export type MailAccount = {
  email: string;
  nickname: string;
  profile?: string | undefined;
};

/**
 * Notifies the desk of mail that arrived, under the account's nickname: a
 * notification per message, or one for all of them when more than
 * {@link MOST_APART} arrive at once. Each is drawn with Gmail's site icon from
 * `icons`, as the launcher draws the account's Gmail. A press opens the
 * message, or the inbox, in the account's Gmail window, opening one if none
 * is. A notification closes once all its messages are read. Rejects when the
 * server refuses.
 */
export const mailNotices = (
  desk: NoticeDesk,
  icons: Favicons,
  open: typeof openMail = openMail,
) => {
  // Each notification still up, by id.
  const shown = new Map<number, Shown>();
  const presses: { listening: Promise<void> | undefined } = {
    listening: undefined,
  };
  return async (
    account: MailAccount,
    { arrived, read }: MailNews,
  ): Promise<void> => {
    presses.listening ??= listen(desk, shown, open);
    await presses.listening;
    const site = inboxAddress(account.email);
    if (arrived.length > 0) {
      await icons.lookFor([site]);
    }
    // The theme's Gmail icon until the site's is found.
    const picture = icons.icon(site).unwrapOr("gmail");
    for (const notice of notices(arrived)) {
      const id = await notify(desk, account.nickname, picture, notice);
      shown.set(id, {
        email: account.email,
        profile: account.profile,
        thread: notice.thread,
        unread: notice.messages,
      });
    }
    for (const [id, notified] of shown) {
      const left = notified.unread.filter((message) => !read.includes(message));
      if (left.length === 0) {
        shown.delete(id);
        await close(desk, id);
      } else {
        shown.set(id, { ...notified, unread: left });
      }
    }
  };
};

/**
 * One notification still up: its account, the thread a press opens, and its
 * unread messages.
 */
type Shown = {
  email: string;
  profile: string | undefined;
  /** The thread a press opens; the inbox for `undefined`. */
  thread: string | undefined;
  unread: readonly string[];
};

type Notice = {
  summary: string;
  body: string;
  /** The thread a press opens, by its hex id; the inbox for `undefined`. */
  thread: string | undefined;
  /** The ids of the messages it tells of. */
  messages: readonly string[];
};

/** `mail`'s notifications, oldest first, so the newest shows on top. */
const notices = (mail: readonly Mail[]): Notice[] =>
  mail.length > MOST_APART
    ? [
        {
          body: senders(mail),
          messages: mail.map(({ id }) => id),
          summary: `${mail.length.toString()} new emails`,
          thread: undefined,
        },
      ]
    : mail.toReversed().map(({ from, id, subject, threadId }) => ({
        body: subject,
        messages: [id],
        summary: from,
        thread: threadId,
      }));

/** Who sent `mail`, each once, newest first. */
const senders = (mail: readonly Mail[]): string => {
  const names = [...new Set(mail.map(({ from }) => from))];
  const more = names.length - MOST_NAMED;
  return new Intl.ListFormat("en-US").format(
    more > 0
      ? [...names.slice(0, MOST_NAMED), `${more.toString()} more`]
      : names,
  );
};

/** Sends `notice`, and resolves its id. */
const notify = async (
  desk: NoticeDesk,
  nickname: string,
  picture: string,
  { body, summary }: Notice,
): Promise<number> =>
  (
    await desk.dbus.call({
      ...SERVER,
      body: [
        nickname,
        0,
        // The theme's mail icon, unless the picture is found.
        "mail-unread",
        summary,
        body,
        ["default", "Open"],
        { "image-path": { signature: "s", value: picture } },
        -1,
      ],
      member: "Notify",
      signature: "susssasa{sv}i",
    })
  ).match({
    Err: (error) => {
      throw new Error(`could not notify of new mail: ${error.message}`);
    },
    Ok: ({ body: reply }) => notifiedSchema.parse(reply)[0],
  });

const notifiedSchema = z.tuple([z.number().int()]);

/** Closes notification `id`; one the user already cleared stays gone. */
const close = async (desk: NoticeDesk, id: number): Promise<void> =>
  (
    await desk.dbus.call({
      ...SERVER,
      body: [id],
      member: "CloseNotification",
      signature: "u",
    })
  ).match({
    Err: (error) => {
      throw new Error(
        `could not clear a read mail's notification: ${error.message}`,
      );
    },
    Ok: () => undefined,
  });

/**
 * Opens each press of one of `shown` from now on with `open`. Resolves once
 * listening, or rejects when the bus refuses.
 */
const listen = async (
  desk: NoticeDesk,
  shown: Map<number, Shown>,
  open: typeof openMail,
): Promise<void> =>
  (
    await desk.dbus.match({
      bus: SERVER.bus,
      interface: SERVER.interface,
      member: "ActionInvoked",
      path: SERVER.path,
    })
  ).match({
    Err: (error) => {
      throw new Error(`could not hear presses of mail: ${error.message}`);
    },
    Ok: (listening) => {
      follow(desk, shown, listening, open).catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: a broken listener leaves presses unanswered, with nothing else to tell
        console.error("Stopped hearing presses of mail", error);
      });
    },
  });

const follow = async (
  desk: NoticeDesk,
  shown: Map<number, Shown>,
  listening: Listening<Listened<DbusSignal>>,
  open: typeof openMail,
): Promise<void> => {
  // Each account's press still waiting for Gmail to start, as its stop.
  const waiting = new Map<string, () => void>();
  const reader = listening.items.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    switch (next.value.kind) {
      case ListenedKind.Heard: {
        // Ours offer only the default action: a press on the notification.
        const [id] = invokedSchema.parse(next.value.item.body);
        const pressed = shown.get(id);
        if (pressed !== undefined) {
          shown.delete(id);
          waiting.get(pressed.email)?.();
          waiting.set(
            pressed.email,
            open(desk.browser, pressed.email, pressed.thread, pressed.profile),
          );
        }
        break;
      }
      case ListenedKind.Missed: {
        // A new compositor numbers its notifications from scratch.
        shown.clear();
        break;
      }
    }
  }
};

const invokedSchema = z.tuple([z.number().int(), z.string()]);
