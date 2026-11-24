import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { Icon } from "@phosphor-icons/react";

export enum InboxReadingKind {
  SignedOut,
  Counted,
  Unread,
  Failed,
}

/** The newest message of an unread conversation. */
export type UnreadMessage = {
  /** The sender's name. */
  from: string;
  subject: string;
  /** When it arrived, in epoch milliseconds. */
  receivedAt: number;
};

/** What the drawer knows of one inbox. Counts are conversations. */
export const InboxReading = {
  /**
   * Every conversation, and the unread ones, with the newest message of each
   * of the newest unread conversations, newest first, and the addresses the
   * account sends from, its own first, when known.
   */
  Counted: (
    total: number,
    unread: number,
    latest: readonly UnreadMessage[] = [],
    addresses: readonly string[] = [],
  ) => ({
    addresses,
    kind: InboxReadingKind.Counted as const,
    latest,
    total,
    unread,
  }),
  /** The read failed, for `reason`. */
  Failed: (reason: string) => ({
    kind: InboxReadingKind.Failed as const,
    reason,
  }),
  /** The inbox needs signing in, or its sign-in was revoked. */
  SignedOut: () => ({ kind: InboxReadingKind.SignedOut as const }),
  /** Only the unread conversations are known. */
  Unread: (unread: number) => ({
    kind: InboxReadingKind.Unread as const,
    unread,
  }),
};

export type InboxReading = ReturnType<
  (typeof InboxReading)[keyof typeof InboxReading]
>;

/** How many of `reading`'s conversations are unread; none if unknown. */
export const unreadIn = (reading: InboxReading | undefined): number => {
  switch (reading?.kind) {
    case InboxReadingKind.Counted:
    case InboxReadingKind.Unread:
      return reading.unread;
    case InboxReadingKind.SignedOut:
    case InboxReadingKind.Failed:
    case undefined:
      return 0;
  }
};

export enum InboxKind {
  Watched,
  Window,
}

/** What every inbox has. */
type Named = {
  icon: Icon;
  /** Its name in the list. */
  name: string;
  /** The account it reads, such as an email address, if it has one. */
  account?: string;
  /**
   * Its name in the launcher, which lists it as an app. `name` when not
   * given.
   */
  launcherName?: string;
  /**
   * The sender its new conversations are notified under, such as a site's
   * origin. Those notifications stay out of the bell's count, which already
   * holds the inbox's unread conversations.
   */
  notifiesAs: string;
};

/**
 * One inbox listed in the notification drawer and the launcher. Its unread
 * conversations count toward the bell.
 */
export const Inbox = {
  /**
   * Read from outside, and opened elsewhere, such as in an app window of its
   * own.
   */
  Watched: (
    inbox: Named & {
      /** Its reading, watched while the shell runs. */
      read: (domicile: Domicile) => SharedWatch<InboxReading>;
      /** Opens it, or signs it in, for a press of its row. */
      open: (domicile: Domicile, reading: InboxReading | undefined) => void;
      /**
       * Writes email from its account, for `mailto:` links: opens a new
       * message from address `from`, filled in from the link `link`. Without
       * it, the inbox writes no email. See {@link sendersOf}.
       */
      write?: (domicile: Domicile, link: string, from: string) => void;
      /**
       * The app window it opens in, if any, which the launcher lists: app
       * `appId`'s, at `url`. With `pageNotifies`, its page notifies what the
       * inbox notifies already, so the page's are cleared as they arrive.
       * With `profile`, it opens in that browser profile rather than its
       * site's.
       */
      app?: {
        appId: string;
        url: string;
        pageNotifies?: boolean;
        profile?: string;
      };
    },
  ) => ({ ...inbox, kind: InboxKind.Watched as const }),
  /**
   * A page in an app window of its own, which runs in the background: it opens
   * hidden when the shell starts, shows when its row is pressed or its page
   * asks to be in front, and hides when closed. So its notifications keep
   * coming and its count stays current.
   */
  Window: (
    inbox: Named & {
      /** The app id of its window. One window per id. */
      appId: string;
      /** The page's address. */
      url: string;
      /**
       * The id of the browser profile its window opens in, such as `work`.
       * By default, the one its site opens in.
       */
      profile?: string;
      /**
       * Calls `onUnread` with the page's unread conversations, read with
       * `countMatches`, which counts the window's elements matching a CSS
       * selector. Returns what stops it.
       */
      countUnread: (
        countMatches: (selector: string) => Promise<number>,
        onUnread: (unread: number) => void,
      ) => () => void;
    },
  ) => ({ ...inbox, kind: InboxKind.Window as const }),
};

export type Inbox = ReturnType<(typeof Inbox)[keyof typeof Inbox]>;

/**
 * The addresses `inbox` writes email from, given its `reading`: those the
 * reading names, else its account's. None when it writes no email.
 */
export const sendersOf = (
  inbox: Inbox,
  reading: InboxReading | undefined,
): readonly string[] => {
  if (inbox.kind !== InboxKind.Watched || inbox.write === undefined) {
    return [];
  } else if (
    reading?.kind === InboxReadingKind.Counted &&
    reading.addresses.length > 0
  ) {
    return reading.addresses;
  } else {
    return inbox.account === undefined ? [] : [inbox.account];
  }
};
