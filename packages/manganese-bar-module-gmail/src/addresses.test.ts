import { describe, expect, it } from "bun:test";

import { composeAddress, draftAddress } from "./addresses";

describe(composeAddress, () => {
  it("opens the account's Gmail with a new message from the link", () => {
    expect(
      composeAddress("me@example.com", "mailto:a@example.com?subject=Hi"),
    ).toBe(
      "https://mail.google.com/mail/?authuser=me%40example.com&extsrc=mailto&url=mailto%3Aa%40example.com%3Fsubject%3DHi",
    );
  });

  it("names no account in a browser profile of its own", () => {
    expect(
      composeAddress("me@example.com", "mailto:a@example.com", "work"),
    ).toBe(
      "https://mail.google.com/mail/?extsrc=mailto&url=mailto%3Aa%40example.com",
    );
  });
});

describe(draftAddress, () => {
  it("opens the account's Gmail on the draft", () => {
    expect(draftAddress("me@example.com", "18c2f0a")).toBe(
      "https://mail.google.com/mail/?authuser=me%40example.com#drafts?compose=18c2f0a",
    );
  });

  it("names no account in a browser profile of its own", () => {
    expect(draftAddress("me@example.com", "18c2f0a", "work")).toBe(
      "https://mail.google.com/mail/#drafts?compose=18c2f0a",
    );
  });
});
