import { Result } from "@cprussin/option-result";

import type { GoogleClient } from "./consent";
import type { Counts, Mail, MailNews, Unread } from "./gmail-api";
import {
  inboxCounts,
  mailHeaders,
  sendAsAddresses,
  unreadMail,
} from "./gmail-api";
import type { Fetch, TokenRefusal } from "./google-token";
import { refreshAccess, TokenRefusalKind } from "./google-token";
import { Inbox } from "./inbox";
import { forgetToken, storedToken } from "./stored-token";

/** How many of the newest unread conversations a reading names. */
const LATEST = 8;

/**
 * An access token, and the addresses the account sends from, read once per
 * token: they change only in Gmail's settings.
 */
type Held = { token: string; expiresAt: number; addresses: readonly string[] };

/**
 * Reads the account's inbox through the Gmail API, each call one read.
 *
 * - Before the account signs in, or once Google revokes its refresh token
 *   (which is then forgotten), it is signed out.
 * - The refresh token gets an access token, kept until it expires or Gmail
 *   refuses it.
 * - Each read names the addresses the account sends from, asked for once
 *   per access token.
 * - Each read names the newest message of each of the {@link LATEST} newest
 *   unread conversations. A message's headers are asked for once.
 * - Each read passes `onMail` the unread messages that arrived since the
 *   last, newest first, and those no longer unread, and waits for it. The
 *   first read after signing in passes none, so mail already there is not
 *   news.
 *
 * A read rejects when Google gives no access token, or Gmail no counts,
 * messages or addresses.
 */
export const inboxReader = (
  domicile: Fetch,
  client: GoogleClient,
  email: string,
  onMail: (news: MailNews) => Promise<void>,
  storage?: Parameters<typeof storedToken>[1],
  now: () => number = Date.now,
): (() => Promise<Inbox>) => {
  const held: { current: Held | undefined } = { current: undefined };
  // Every unread message seen since signing in, those unread at the last
  // read, and the headers read of those; `undefined` before the first read.
  const seen: {
    ids: ReadonlySet<string> | undefined;
    unread: readonly string[];
    headers: ReadonlyMap<string, Mail>;
  } = { headers: new Map(), ids: undefined, unread: [] };

  const count = async (access: Held): Promise<Inbox> =>
    (await readMail(domicile, access.token, seen.ids, seen.headers)).match({
      Err: (why): Promise<Inbox> => {
        held.current = undefined;
        throw new Error(why);
      },
      Ok: async ({ counts, headers, ids, latest, mail }) => {
        const read = seen.unread.filter((id) => !ids.includes(id));
        seen.ids = new Set([...(seen.ids ?? []), ...ids]);
        seen.unread = ids;
        seen.headers = headers;
        if (mail.length > 0 || read.length > 0) {
          await onMail({ arrived: mail, read });
        }
        return Inbox.Counted(
          counts.total,
          counts.unread,
          latest,
          access.addresses,
        );
      },
    });

  const signedOut = (): Inbox => {
    seen.ids = undefined;
    seen.unread = [];
    seen.headers = new Map();
    return Inbox.SignedOut();
  };

  const refused = (refusal: TokenRefusal): Inbox => {
    switch (refusal.kind) {
      case TokenRefusalKind.Revoked: {
        forgetToken(email, storage);
        return signedOut();
      }
      case TokenRefusalKind.Failed: {
        throw new Error(refusal.reason);
      }
    }
  };

  const refreshed = async (refreshToken: string): Promise<Inbox> => {
    const askedAt = now();
    return (await refreshAccess(domicile, client, refreshToken)).match({
      Err: (refusal) => Promise.resolve(refused(refusal)),
      Ok: async (access) =>
        (await sendAsAddresses(domicile, access.token)).match({
          Err: (why): Promise<Inbox> => {
            throw new Error(why);
          },
          Ok: (addresses) => {
            held.current = {
              addresses,
              expiresAt: askedAt + access.expiresInMs,
              token: access.token,
            };
            return count(held.current);
          },
        }),
    });
  };

  return () =>
    storedToken(email, storage).match({
      None: () => Promise.resolve(signedOut()),
      Some: (refreshToken) => {
        const access = held.current;
        return access === undefined || now() >= access.expiresAt
          ? refreshed(refreshToken)
          : count(access);
      },
    });
};

/** What one read of the inbox finds. */
type Read = {
  counts: Counts;
  /** The ids of the unread messages, newest first. */
  ids: string[];
  /** The headers of the unread messages read so far, by id. */
  headers: ReadonlyMap<string, Mail>;
  /** The newest message of each of the newest unread conversations. */
  latest: Mail[];
  /** The unread messages not in `seen`. */
  mail: Mail[];
};

/**
 * The inbox's counts and unread messages, the headers of those not in `seen`
 * (none when nothing was seen yet), and of the newest unread conversations.
 * Headers already in `known` are not asked for again.
 */
const readMail = async (
  domicile: Fetch,
  token: string,
  seen: ReadonlySet<string> | undefined,
  known: ReadonlyMap<string, Mail>,
): Promise<Result<Read, string>> => {
  const [counts, unread] = await Promise.all([
    inboxCounts(domicile, token),
    unreadMail(domicile, token),
  ]);
  return counts
    .andThen((counted) => unread.map((listed) => ({ counted, listed })))
    .andThenAsync(async ({ counted, listed }) => {
      const ids = listed.map(({ id }) => id);
      const fresh = seen === undefined ? [] : ids.filter((id) => !seen.has(id));
      const newest = newestPerThread(listed);
      const asked = [...new Set([...fresh, ...newest])].filter(
        (id) => !known.has(id),
      );
      const answered = Result.collect(
        await Promise.all(asked.map((id) => mailHeaders(domicile, token, id))),
      );
      return answered.map((got) => {
        const headers = new Map(
          [...known, ...got.map((one) => [one.id, one] as const)].filter(
            ([id]) => ids.includes(id),
          ),
        );
        return {
          counts: counted,
          headers,
          ids,
          latest: newest.map((id) => headersOf(headers, id)),
          mail: fresh.map((id) => headersOf(headers, id)),
        };
      });
    });
};

/** The ids of the newest message of each of the {@link LATEST} newest threads. */
const newestPerThread = (listed: readonly Unread[]): string[] =>
  listed
    .filter(
      ({ threadId }, index) =>
        listed.findIndex((other) => other.threadId === threadId) === index,
    )
    .slice(0, LATEST)
    .map(({ id }) => id);

/** Message `id`'s headers, which were just read. */
const headersOf = (headers: ReadonlyMap<string, Mail>, id: string): Mail => {
  const found = headers.get(id);
  if (found === undefined) {
    throw new Error(`no headers were read for message ${id}`);
  } else {
    return found;
  }
};
