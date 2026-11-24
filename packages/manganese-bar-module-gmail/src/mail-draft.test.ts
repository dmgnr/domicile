import { describe, expect, it } from "bun:test";

import { draftMessage, mailLink } from "./mail-draft";

describe(mailLink, () => {
  it("reads the recipients, subject and body", () => {
    expect(
      mailLink(
        "mailto:a@example.com,b@example.com?cc=c@example.com&BCC=d@example.com&to=e@example.com&subject=Hi%20there&body=Line%201%0D%0ALine+2",
      ),
    ).toStrictEqual({
      bcc: ["d@example.com"],
      body: "Line 1\r\nLine+2",
      cc: ["c@example.com"],
      subject: "Hi there",
      to: ["a@example.com", "b@example.com", "e@example.com"],
    });
  });

  it("is empty but for the recipient of a bare link", () => {
    expect(mailLink("mailto:a@example.com")).toStrictEqual({
      bcc: [],
      body: "",
      cc: [],
      subject: "",
      to: ["a@example.com"],
    });
  });

  it("keeps a broken escape as it is", () => {
    expect(mailLink("mailto:?subject=100%").subject).toBe("100%");
  });
});

describe(draftMessage, () => {
  it("is a plain text message from the address, with the link's fields", () => {
    expect(
      draftMessage("alias@example.com", {
        bcc: [],
        body: "Hi\nthere",
        cc: ["c@example.com"],
        subject: "Hello",
        to: ["a@example.com", "b@example.com"],
      }),
    ).toBe(
      [
        "From: alias@example.com",
        "To: a@example.com, b@example.com",
        "Cc: c@example.com",
        "Subject: Hello",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        "SGkNCnRoZXJl",
      ].join("\r\n"),
    );
  });

  it("encodes a subject that isn't plain ASCII", () => {
    expect(
      draftMessage("alias@example.com", {
        bcc: [],
        body: "",
        cc: [],
        subject: "Café",
        to: [],
      }),
    ).toContain("\r\nSubject: =?UTF-8?B?Q2Fmw6k=?=\r\n");
  });
});
