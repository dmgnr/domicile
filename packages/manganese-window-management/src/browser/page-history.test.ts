import { describe, expect, it } from "bun:test";

import { pageHistoryFor, pageHistoryOf } from "./page-history";

const PAGE = {
  favicon: "",
  id: 7,
  title: "Hacker News",
  url: "https://news.ycombinator.com/",
};

const HISTORY = { back: [PAGE], forward: [] };

describe("pageHistoryOf", () => {
  it("reads the engine's history", () => {
    expect(pageHistoryOf(HISTORY)).toStrictEqual(HISTORY);
  });

  it("throws for anything else", () => {
    expect(() => pageHistoryOf({ back: [{ id: "7" }], forward: [] })).toThrow();
  });
});

describe("pageHistoryFor", () => {
  it("is nothing from an engine without history entries", () => {
    expect(
      pageHistoryFor(
        document.createElement("div") as unknown as HTMLWebViewElement,
      ),
    ).toBeUndefined();
  });

  it("lists the view's history and goes to its entries", async () => {
    const went: string[] = [];
    const view = Object.assign(document.createElement("div"), {
      goToHistoryEntry: (id: number) => {
        went.push(`here ${id}`);
      },
      goToHistoryEntryInNewWindow: (id: number) => {
        went.push(`new window ${id}`);
      },
      history: () => Promise.resolve(HISTORY),
    }) as unknown as HTMLWebViewElement;
    const history = pageHistoryFor(view);

    expect(await history?.list()).toStrictEqual(HISTORY);
    history?.go(7);
    history?.goInNewWindow(7);
    expect(went).toStrictEqual(["here 7", "new window 7"]);
  });
});
