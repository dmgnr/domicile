import { describe, expect, it } from "bun:test";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";

import { Inbox, InboxReading, sendersOf } from "./inbox";

const mailInbox = (write?: () => void) =>
  Inbox.Watched({
    account: "me@example.com",
    icon: EnvelopeSimpleIcon,
    name: "Me",
    notifiesAs: "Me",
    open: () => undefined,
    read: () => {
      throw new Error("not read");
    },
    ...(write === undefined ? {} : { write }),
  });

describe(sendersOf, () => {
  it("is the addresses the reading names", () => {
    expect(
      sendersOf(
        mailInbox(() => undefined),
        InboxReading.Counted(1, 0, [], ["me@example.com", "me@work.example"]),
      ),
    ).toStrictEqual(["me@example.com", "me@work.example"]);
  });

  it("is the account's address before the reading names any", () => {
    expect(
      sendersOf(
        mailInbox(() => undefined),
        InboxReading.SignedOut(),
      ),
    ).toStrictEqual(["me@example.com"]);
  });

  it("is none for an inbox that writes no email", () => {
    expect(
      sendersOf(
        mailInbox(),
        InboxReading.Counted(1, 0, [], ["me@example.com"]),
      ),
    ).toStrictEqual([]);
  });
});
