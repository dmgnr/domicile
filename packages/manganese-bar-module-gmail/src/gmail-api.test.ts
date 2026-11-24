import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";

import {
  createDraft,
  inboxCounts,
  mailHeaders,
  sendAsAddresses,
  unreadMail,
} from "./gmail-api";
import {
  answering,
  DRAFTS,
  HEADERS,
  INBOX,
  json,
  SEND_AS,
  UNREAD,
} from "./held-google";

describe("inboxCounts", () => {
  it("counts the inbox's conversations, with the access token", async () => {
    const { domicile, fetched } = answering({
      [INBOX]: [
        json(200, {
          id: "INBOX",
          messagesTotal: 9,
          messagesUnread: 3,
          threadsTotal: 4,
          threadsUnread: 2,
        }),
      ],
    });

    expect(await inboxCounts(domicile, "acc3ss")).toStrictEqual(
      Ok({ total: 4, unread: 2 }),
    );
    expect(fetched).toStrictEqual([
      {
        body: null,
        headers: [{ name: "Authorization", value: "Bearer acc3ss" }],
        method: "GET",
        url: INBOX,
      },
    ]);
  });

  it("fails with Gmail's answer when it refuses", async () => {
    const { domicile } = answering({
      [INBOX]: [json(401, { error: { code: 401 } })],
    });

    expect(await inboxCounts(domicile, "acc3ss")).toStrictEqual(
      Err('Gmail answered 401: {"error":{"code":401}}'),
    );
  });

  it("fails when the browser cannot ask", async () => {
    const { domicile } = answering({ [INBOX]: [new Error("offline")] });

    expect(await inboxCounts(domicile, "acc3ss")).toStrictEqual(
      Err("the browser could not ask Gmail: Error: offline"),
    );
  });
});

describe("unreadMail", () => {
  it("lists the inbox's unread messages, newest first", async () => {
    const { domicile } = answering({
      [UNREAD]: [
        json(200, {
          messages: [
            { id: "m2", threadId: "1a" },
            { id: "m1", threadId: "1a" },
          ],
          resultSizeEstimate: 2,
        }),
      ],
    });

    expect(await unreadMail(domicile, "acc3ss")).toStrictEqual(
      Ok([
        { id: "m2", threadId: "1a" },
        { id: "m1", threadId: "1a" },
      ]),
    );
  });

  it("lists none when Gmail leaves the list out", async () => {
    const { domicile } = answering({
      [UNREAD]: [json(200, { resultSizeEstimate: 0 })],
    });

    expect(await unreadMail(domicile, "acc3ss")).toStrictEqual(Ok([]));
  });
});

describe("mailHeaders", () => {
  it("reads a message's sender, subject and arrival", async () => {
    const { domicile, fetched } = answering({
      [HEADERS("m1")]: [
        json(200, {
          id: "m1",
          internalDate: "1761955200000",
          payload: {
            headers: [
              { name: "Subject", value: "Dinner Friday?" },
              { name: "From", value: '"Alex Chen" <alex@example.com>' },
            ],
          },
          threadId: "1a",
        }),
      ],
    });

    expect(await mailHeaders(domicile, "acc3ss", "m1")).toStrictEqual(
      Ok({
        from: "Alex Chen",
        id: "m1",
        receivedAt: 1_761_955_200_000,
        subject: "Dinner Friday?",
        threadId: "1a",
      }),
    );
    expect(fetched[0]?.headers).toStrictEqual([
      { name: "Authorization", value: "Bearer acc3ss" },
    ]);
  });

  it.each([
    ["alex@example.com", "alex@example.com"],
    ['"" <alex@example.com>', "alex@example.com"],
  ])(
    "names a sender who gives no name, %p, by their address",
    async (from, named) => {
      const { domicile } = answering({
        [HEADERS("m1")]: [
          json(200, {
            id: "m1",
            internalDate: "1",
            payload: { headers: [{ name: "From", value: from }] },
            threadId: "1a",
          }),
        ],
      });

      expect(await mailHeaders(domicile, "acc3ss", "m1")).toStrictEqual(
        Ok({
          from: named,
          id: "m1",
          receivedAt: 1,
          subject: "(no subject)",
          threadId: "1a",
        }),
      );
    },
  );

  it("fails on a thread id that is not Gmail's hex", async () => {
    const { domicile } = answering({
      [HEADERS("m1")]: [
        json(200, {
          id: "m1",
          internalDate: "1",
          payload: { headers: [] },
          threadId: '"] *',
        }),
      ],
    });

    expect((await mailHeaders(domicile, "acc3ss", "m1")).isErr()).toBe(true);
  });

  it("names a message with no sender as unknown", async () => {
    const { domicile } = answering({
      [HEADERS("m1")]: [
        json(200, {
          id: "m1",
          internalDate: "1",
          payload: { headers: [{ name: "Subject", value: "Hi" }] },
          threadId: "1a",
        }),
      ],
    });

    expect(await mailHeaders(domicile, "acc3ss", "m1")).toStrictEqual(
      Ok({
        from: "Unknown sender",
        id: "m1",
        receivedAt: 1,
        subject: "Hi",
        threadId: "1a",
      }),
    );
  });
});

describe("sendAsAddresses", () => {
  it("lists the account's own address, then its verified aliases", async () => {
    const { domicile } = answering({
      [SEND_AS]: [
        json(200, {
          sendAs: [
            { sendAsEmail: "me@work.example", verificationStatus: "accepted" },
            { isPrimary: true, sendAsEmail: "me@example.com" },
            { sendAsEmail: "me@old.example", verificationStatus: "pending" },
          ],
        }),
      ],
    });

    expect(await sendAsAddresses(domicile, "acc3ss")).toStrictEqual(
      Ok(["me@example.com", "me@work.example"]),
    );
  });

  it("fails with Gmail's answer when it refuses", async () => {
    const { domicile } = answering({ [SEND_AS]: [json(403, {})] });

    expect(await sendAsAddresses(domicile, "acc3ss")).toStrictEqual(
      Err("Gmail answered 403: {}"),
    );
  });
});

describe("createDraft", () => {
  it("saves the message as a draft, in base64url, and names its message", async () => {
    const { domicile, fetched } = answering({
      [DRAFTS]: [json(200, { id: "r-1", message: { id: "18c2f0a" } })],
    });

    expect(await createDraft(domicile, "acc3ss", "Subject: é?>")).toStrictEqual(
      Ok("18c2f0a"),
    );
    expect(fetched).toStrictEqual([
      {
        body: JSON.stringify({ message: { raw: "U3ViamVjdDogw6k_Pg==" } }),
        headers: [
          { name: "Authorization", value: "Bearer acc3ss" },
          { name: "Content-Type", value: "application/json" },
        ],
        method: "POST",
        url: DRAFTS,
      },
    ]);
  });

  it("fails with Gmail's answer when it refuses", async () => {
    const { domicile } = answering({ [DRAFTS]: [json(403, {})] });

    expect(await createDraft(domicile, "acc3ss", "")).toStrictEqual(
      Err("Gmail answered 403: {}"),
    );
  });
});
