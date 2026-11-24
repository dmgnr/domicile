import { describe, expect, it } from "bun:test";

import { isTheJournal, journalLine, Priority } from "./journal";

describe(isTheJournal, () => {
  it("is the stream JOURNAL_STREAM names, by device and inode", () => {
    expect(isTheJournal("8:1234", { dev: 8n, ino: 1234n })).toBe(true);
    expect(isTheJournal("8:1234", { dev: 8n, ino: 99n })).toBe(false);
    expect(isTheJournal("8:1234", { dev: 9n, ino: 1234n })).toBe(false);
    expect(isTheJournal(undefined, { dev: 8n, ino: 1234n })).toBe(false);
  });
});

describe(journalLine, () => {
  it("gives each line its priority on the journal", () => {
    expect(journalLine(Priority.Debug, "one\ntwo", true)).toBe(
      "<7>one\n<7>two",
    );
  });

  it("is the text as said anywhere else", () => {
    expect(journalLine(Priority.Error, "one\ntwo", false)).toBe("one\ntwo");
  });
});
