import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { z } from "zod";
import type { Fetch } from "./google-token";

import { jsonText } from "./json-text";

/** The Gmail API's messages for the signed-in account. */
const MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** The Gmail API's drafts of the signed-in account. */
const DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

/** The Gmail API's addresses the account sends from. */
const SEND_AS =
  "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";

/** The Gmail API's inbox label, which carries its counts. */
const INBOX = "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX";

/**
 * The newest unread messages in the inbox. Enough that a read misses none
 * that arrived, and a notified message leaves the list only once read.
 */
const UNREAD = `${MESSAGES}?${new URLSearchParams([
  ["labelIds", "INBOX"],
  ["labelIds", "UNREAD"],
  ["maxResults", "100"],
]).toString()}`;

/** The inbox's conversations: every one, and the unread ones. */
export type Counts = { total: number; unread: number };

/** One message, as a notification names it. */
export type Mail = {
  id: string;
  threadId: string;
  /** The sender's name, or their address when the message names none. */
  from: string;
  subject: string;
  /** When Gmail received it, in epoch milliseconds. */
  receivedAt: number;
};

/** One unread message in the inbox's list. */
export type Unread = { id: string; threadId: string };

/** What changed in the inbox's unread messages between two reads. */
export type MailNews = {
  /** The messages that arrived, newest first. */
  arrived: readonly Mail[];
  /** The ids of those no longer unread in the inbox. */
  read: readonly string[];
};

/** Asks the Gmail API for the inbox's conversation counts. */
export const inboxCounts = (
  domicile: Fetch,
  accessToken: string,
): Promise<Result<Counts, string>> =>
  ask(domicile, accessToken, INBOX, labelSchema);

/** Asks the Gmail API for the inbox's unread messages, newest first. */
export const unreadMail = (
  domicile: Fetch,
  accessToken: string,
): Promise<Result<Unread[], string>> =>
  ask(domicile, accessToken, UNREAD, unreadSchema);

/**
 * Asks the Gmail API for the addresses the account sends from: its own,
 * then the aliases it verified, in Gmail's order.
 */
export const sendAsAddresses = (
  domicile: Fetch,
  accessToken: string,
): Promise<Result<string[], string>> =>
  ask(domicile, accessToken, SEND_AS, sendAsSchema);

/**
 * Saves the RFC 5322 message `message` as a new draft. Resolves the draft's
 * message id: Gmail's hex number, which its web app opens the draft by.
 */
export const createDraft = (
  domicile: Fetch,
  accessToken: string,
  message: string,
): Promise<Result<string, string>> =>
  ask(domicile, accessToken, DRAFTS, draftSchema, {
    message: { raw: base64Url(new TextEncoder().encode(message)) },
  });

/** Asks the Gmail API for message `id`'s sender, subject and arrival. */
export const mailHeaders = (
  domicile: Fetch,
  accessToken: string,
  id: string,
): Promise<Result<Mail, string>> =>
  ask(
    domicile,
    accessToken,
    `${MESSAGES}/${encodeURIComponent(id)}?${new URLSearchParams([
      ["format", "metadata"],
      ["metadataHeaders", "From"],
      ["metadataHeaders", "Subject"],
    ]).toString()}`,
    headersSchema,
  );

/** GETs `url`, or POSTs `posted` as JSON to it, and reads the answer. */
const ask = <T extends {}>(
  domicile: Fetch,
  accessToken: string,
  url: string,
  schema: z.ZodType<T, string>,
  posted?: object,
): Promise<Result<T, string>> =>
  domicile.browser
    .fetch(url, {
      headers: [
        { name: "Authorization", value: `Bearer ${accessToken}` },
        ...(posted === undefined
          ? []
          : [{ name: "Content-Type", value: "application/json" }]),
      ],
      ...(posted === undefined
        ? {}
        : { body: JSON.stringify(posted), method: "POST" as const }),
    })
    .then(
      (answer): Result<T, string> => {
        if (answer.status === 200) {
          const fields = schema.safeParse(answer.body);
          return fields.success
            ? Ok(fields.data)
            : Err(z.prettifyError(fields.error));
        } else {
          return Err(
            `Gmail answered ${answer.status.toString()}: ${answer.body}`,
          );
        }
      },
      (error: unknown) =>
        Err(`the browser could not ask Gmail: ${String(error)}`),
    );

const labelSchema = jsonText.pipe(
  z
    .object({
      threadsTotal: z.number().int().nonnegative(),
      threadsUnread: z.number().int().nonnegative(),
    })
    .transform((label) => ({
      total: label.threadsTotal,
      unread: label.threadsUnread,
    })),
);

// Gmail leaves `messages` out when there are none.
const unreadSchema = jsonText.pipe(
  z
    .object({
      messages: z
        .array(z.object({ id: z.string(), threadId: z.string() }))
        .default([]),
    })
    .transform(({ messages }) =>
      messages.map(({ id, threadId }) => ({ id, threadId })),
    ),
);

const draftSchema = jsonText.pipe(
  z
    .object({ message: z.object({ id: z.string().regex(/^[0-9a-f]+$/) }) })
    .transform(({ message }) => message.id),
);

/** `bytes` in base64url, as the Gmail API takes a raw message. */
const base64Url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_");

// An alias Gmail has not verified cannot send yet. The primary address has
// no verification status.
const sendAsSchema = jsonText.pipe(
  z
    .object({
      sendAs: z.array(
        z.object({
          isPrimary: z.boolean().optional(),
          sendAsEmail: z.string(),
          verificationStatus: z.string().optional(),
        }),
      ),
    })
    .transform(({ sendAs }) => [
      ...sendAs
        .filter(({ isPrimary }) => isPrimary === true)
        .map(({ sendAsEmail }) => sendAsEmail),
      ...sendAs
        .filter(
          ({ isPrimary, verificationStatus }) =>
            isPrimary !== true && verificationStatus === "accepted",
        )
        .map(({ sendAsEmail }) => sendAsEmail),
    ]),
);

/**
 * A thread's id: Gmail's hex number, which a press names the thread's row and
 * link by.
 */
const threadIdSchema = z.string().regex(/^[0-9a-f]+$/);

const headersSchema = jsonText.pipe(
  z
    .object({
      id: z.string(),
      // Epoch milliseconds, as a string.
      internalDate: z.coerce.number().int(),
      payload: z.object({
        headers: z.array(z.object({ name: z.string(), value: z.string() })),
      }),
      threadId: threadIdSchema,
    })
    .transform(({ id, internalDate, payload, threadId }) => {
      const header = (name: string) =>
        payload.headers.find((one) => one.name.toLowerCase() === name)?.value;
      const subject = header("subject") ?? "";
      return {
        from: senderName(header("from") ?? "Unknown sender"),
        id,
        receivedAt: internalDate,
        subject: subject === "" ? "(no subject)" : subject,
        threadId,
      };
    }),
);

/**
 * `Alex Chen <alex@example.com>` is `Alex Chen`, `<alex@example.com>` is
 * `alex@example.com`, and a bare address is itself.
 */
const senderName = (from: string): string => {
  const [, name, address] =
    /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/u.exec(from) ?? [];
  if (name === undefined || address === undefined) {
    return from.trim();
  } else {
    return name === "" ? address : name;
  }
};
