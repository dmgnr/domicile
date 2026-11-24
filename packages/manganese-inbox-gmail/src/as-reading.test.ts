import { describe, expect, it } from "bun:test";
import { Inbox } from "@domicile-desktop/manganese-bar-module-gmail/inbox";
import { InboxReading } from "@domicile-desktop/manganese-notifications/inbox";

import { asReading } from "./as-reading";

describe(asReading, () => {
  it("reads a counted inbox with its newest unread mail", () => {
    const mail = {
      from: "Alex Chen",
      id: "m1",
      receivedAt: 7,
      subject: "Dinner Friday?",
      threadId: "t1",
    };

    expect(
      asReading(Inbox.Counted(12, 3, [mail], ["me@example.com"])),
    ).toStrictEqual(
      InboxReading.Counted(
        12,
        3,
        [{ from: "Alex Chen", receivedAt: 7, subject: "Dinner Friday?" }],
        ["me@example.com"],
      ),
    );
  });

  it.each([
    [Inbox.SignedOut(), InboxReading.SignedOut()],
    [Inbox.Failed("offline"), InboxReading.Failed("offline")],
  ])("reads %p as %p", (gmail, reading) => {
    expect(asReading(gmail)).toStrictEqual(reading);
  });
});
