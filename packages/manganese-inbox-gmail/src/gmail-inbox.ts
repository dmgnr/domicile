import {
  gmailAppId,
  inboxAddress,
} from "@domicile-desktop/manganese-bar-module-gmail/addresses";
import type { GoogleClient } from "@domicile-desktop/manganese-bar-module-gmail/consent";
import { deskInbox } from "@domicile-desktop/manganese-bar-module-gmail/desk-inbox";
import type { Inbox as GmailReading } from "@domicile-desktop/manganese-bar-module-gmail/inbox";
import { writeMail } from "@domicile-desktop/manganese-bar-module-gmail/write-mail";
import type { InboxReading } from "@domicile-desktop/manganese-notifications/inbox";
import {
  Inbox,
  InboxReadingKind,
} from "@domicile-desktop/manganese-notifications/inbox";
import { perDesktop } from "@domicile-desktop/react/per-desktop";
import type { SharedWatch } from "@domicile-desktop/react/shared-watch";
import { sharedWatch } from "@domicile-desktop/react/shared-watch";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";

import { asReading } from "./as-reading";

type Options = {
  /** The Google Cloud OAuth client (Desktop app) it signs in with. */
  client: GoogleClient;
  /** The Google account, such as `me@gmail.com`. */
  email: string;
  /** The account's name in the drawer, such as `Work`. */
  nickname: string;
  /** Its name in the launcher, such as `Email - Work`. `nickname` if not given. */
  launcherName?: string;
  /**
   * The id of the browser profile its Gmail window and sign-in open in, such
   * as `work`. By default, the one Gmail's site opens in. Given one, the
   * window opens Gmail's own address, with the profile's Google sign-in,
   * rather than picking the account by its address.
   */
  profile?: string;
};

/**
 * One Gmail account's inbox in the notification drawer and the launcher,
 * read with the Gmail API: its conversations, with the unread ones counted
 * toward the bell. A press opens it in the account's own Gmail window, or
 * brings that window up, or signs it in. Writes email for `mailto:` links in
 * that window, from the account or one of its Gmail aliases. Goes in
 * `runManganese`'s `inboxes`.
 */
export const gmailInbox = ({
  client,
  email,
  launcherName,
  nickname,
  profile,
}: Options): Inbox =>
  Inbox.Watched({
    account: email,
    // Gmail's page notifies the same mail while its window is open.
    app: {
      appId: gmailAppId(email),
      pageNotifies: true,
      ...(profile === undefined ? {} : { profile }),
      url: inboxAddress(email, profile),
    },
    icon: EnvelopeSimpleIcon,
    ...(launcherName === undefined ? {} : { launcherName }),
    name: nickname,
    notifiesAs: nickname,
    open: (domicile, reading) => {
      if (reading?.kind === InboxReadingKind.SignedOut) {
        deskInbox(domicile)(email, client, nickname, profile).signIn();
      } else {
        domicile.browser.openApp(inboxAddress(email, profile), {
          id: gmailAppId(email),
          reuse: AppReuse.Focus,
          ...(profile === undefined ? {} : { profile }),
        });
      }
    },
    read: perDesktop((domicile) =>
      asReadings(deskInbox(domicile)(email, client, nickname, profile).inbox),
    ),
    write: (domicile, link, from) => {
      void writeMail(domicile, client, email, link, from, profile);
    },
  });

/** `watch`'s readings, as the drawer reads them. */
const asReadings = (watch: SharedWatch<GmailReading>) =>
  sharedWatch<InboxReading>((onReading) =>
    watch.subscribe(() => {
      const reading = watch.current();
      if (reading !== undefined) {
        onReading(asReading(reading));
      }
    }),
  );
