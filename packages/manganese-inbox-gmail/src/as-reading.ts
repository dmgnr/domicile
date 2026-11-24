import type { Inbox as GmailReading } from "@domicile-desktop/manganese-bar-module-gmail/inbox";
import { InboxKind as GmailKind } from "@domicile-desktop/manganese-bar-module-gmail/inbox";
import { InboxReading } from "@domicile-desktop/manganese-notifications/inbox";

/** A Gmail account's reading, as the drawer and the launcher read it. */
export const asReading = (reading: GmailReading): InboxReading => {
  switch (reading.kind) {
    case GmailKind.SignedOut:
      return InboxReading.SignedOut();
    case GmailKind.Counted:
      return InboxReading.Counted(
        reading.total,
        reading.unread,
        reading.latest.map(({ from, receivedAt, subject }) => ({
          from,
          receivedAt,
          subject,
        })),
        reading.addresses,
      );
    case GmailKind.Failed:
      return InboxReading.Failed(reading.reason);
  }
};
