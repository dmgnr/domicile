// Gives electron-host's own lines their priorities when its stderr is a
// journal stream, as `domicile open --electron` gives each app one. The
// app's own output stays at the stream's `info`. See sd-daemon(3).

import { fstatSync } from "node:fs";

import { readEnvironment } from "./environment";

/** A syslog priority, as a journal stream's `<n>` prefix gives it. */
export enum Priority {
  Error = 3,
  Warning = 4,
  Debug = 7,
}

/**
 * Whether the stream with this device and inode is the one `journalStream`,
 * `JOURNAL_STREAM`'s `<device>:<inode>`, names.
 */
export const isTheJournal = (
  journalStream: string | undefined,
  stat: { readonly dev: bigint; readonly ino: bigint },
) => journalStream === `${stat.dev}:${stat.ino}`;

/** `text` for stderr: each line prefixed with `priority` on the journal. */
export const journalLine = (
  priority: Priority,
  text: string,
  onJournal: boolean,
) =>
  onJournal
    ? text
        .split("\n")
        .map((line) => `<${priority}>${line}`)
        .join("\n")
    : text;

/** Whether this process's stderr is the journal, which systemd's numbers say. */
const onJournal = isTheJournal(
  readEnvironment().JOURNAL_STREAM,
  fstatSync(2, { bigint: true }),
);

/** Says one of electron-host's own lines on stderr at `priority`. */
export const say = (priority: Priority, text: string) => {
  // biome-ignore lint/suspicious/noConsole: electron-host's own lines, for the desktop's log
  console.error(journalLine(priority, text, onJournal));
};
