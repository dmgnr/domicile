import { perDesktop } from "@domicile-desktop/react/per-desktop";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { sharedWatch } from "@domicile-desktop/react/shared-watch";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { curlFetch } from "@domicile-desktop/system-apps/curl";
import { favicon } from "@domicile-desktop/system-apps/favicon";
import { favicons } from "@domicile-desktop/system-apps/favicons";

import type { GoogleClient } from "./consent";
import type { MailNews } from "./gmail-api";
import { watchGmailWindows } from "./gmail-windows";
import type { Inbox } from "./inbox";
import { mailNotices } from "./mail-notices";
import { inboxReader } from "./read-inbox";
import { signIn } from "./sign-in";
import type { InboxWatch } from "./watch-inbox";
import { watchInbox } from "./watch-inbox";

/** One account on the desk. */
export type DeskAccount = {
  /** Its inbox, watched while any bar shows it. */
  inbox: SharedWatch<Inbox>;
  /**
   * Signs it in, then reads the inbox. A failed sign-in is a failed read.
   * Only while a bar shows it.
   */
  signIn: () => void;
};

/**
 * Each account's inbox, watched once for every bar on the desk. Read again
 * soon after a Gmail window changes. Paused while the desk is locked, which
 * refuses the reads. New mail is notified under the account's `nickname`.
 */
export const deskInbox = perDesktop((domicile) => {
  const accounts = new Map<string, DeskAccount>();
  const notify = mailNotices(
    domicile,
    favicons((url) => favicon(url, curlFetch(domicile))),
  );
  return (
    email: string,
    client: GoogleClient,
    nickname: string,
    profile?: string,
  ): DeskAccount => {
    const known = accounts.get(email);
    if (known === undefined) {
      const account = watchedAccount(domicile, email, client, profile, (news) =>
        notify({ email, nickname, profile }, news),
      );
      accounts.set(email, account);
      return account;
    } else {
      return known;
    }
  };
});

const watchedAccount = (
  domicile: Domicile,
  email: string,
  client: GoogleClient,
  profile: string | undefined,
  onMail: (news: MailNews) => Promise<void>,
): DeskAccount => {
  const read = inboxReader(domicile, client, email, onMail);
  const running: { watch: InboxWatch | undefined } = { watch: undefined };
  return {
    inbox: sharedWatch((onInbox: (inbox: Inbox) => void) => {
      const watch = watchInbox(
        read,
        onInbox,
        () => domicile.session.locked === true,
      );
      const stopGmail = watchGmailWindows(domicile, watch.readSoon);
      running.watch = watch;
      return () => {
        stopGmail();
        watch.stop();
        running.watch = undefined;
      };
    }),
    signIn: () => {
      if (running.watch === undefined) {
        throw new Error(`no bar shows ${email} to sign in from`);
      } else {
        running.watch.answer(
          signIn(domicile, client, email, profile).then(() => read()),
        );
      }
    },
  };
};
