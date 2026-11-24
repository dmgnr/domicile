// A browser window's history either side of its page, for the back and
// forward menus, through the `<webview>`.
//
// The engine keeps the history; this module only parses what it reports.

import { z } from "zod";

/** A page in the history. */
export type PageHistoryEntry = z.infer<typeof entrySchema>;

/** The pages behind and ahead of the current one, each nearest first. */
export type PageHistory = z.infer<typeof historySchema>;

/** Lists a view's history, and goes to an entry of it. */
export type PageHistoryChoice = {
  list: () => Promise<PageHistory>;
  go: (id: number) => void;
  goInNewWindow: (id: number) => void;
};

/** Parses `view.history()`'s answer. Throws for anything else. */
export const pageHistoryOf = (reported: unknown): PageHistory =>
  historySchema.parse(reported);

/**
 * `view`'s history, or nothing from an engine without history entries, as
 * `mediaDeviceChoiceFor` allows for an engine without media devices.
 */
export const pageHistoryFor = (
  view: HTMLWebViewElement,
): PageHistoryChoice | undefined =>
  "history" in view
    ? {
        go: (id) => {
          view.goToHistoryEntry(id);
        },
        goInNewWindow: (id) => {
          view.goToHistoryEntryInNewWindow(id);
        },
        list: () => view.history().then(pageHistoryOf),
      }
    : undefined;

const entrySchema = z.object({
  favicon: z.string(),
  id: z.number(),
  title: z.string(),
  url: z.string(),
});

const historySchema = z.object({
  back: z.array(entrySchema),
  forward: z.array(entrySchema),
});
