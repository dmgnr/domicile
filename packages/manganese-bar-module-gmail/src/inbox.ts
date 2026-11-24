import type { Mail } from "./gmail-api";

export enum InboxKind {
  SignedOut,
  Counted,
  Failed,
}

/** What the bar knows of one account's inbox. Counts are conversations. */
export const Inbox = {
  /**
   * Every conversation, and the unread ones, with the newest message of each
   * of the newest unread conversations, and the addresses the account sends
   * from: its own, then its aliases.
   */
  Counted: (
    total: number,
    unread: number,
    latest: readonly Mail[] = [],
    addresses: readonly string[] = [],
  ) => ({
    addresses,
    kind: InboxKind.Counted as const,
    latest,
    total,
    unread,
  }),
  /** The read failed, for `reason`. */
  Failed: (reason: string) => ({ kind: InboxKind.Failed as const, reason }),
  /** The account has not signed in, or Google revoked its sign-in. */
  SignedOut: () => ({ kind: InboxKind.SignedOut as const }),
};

export type Inbox = ReturnType<(typeof Inbox)[keyof typeof Inbox]>;
