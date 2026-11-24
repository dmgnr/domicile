import { describe, expect, it } from "bun:test";

import { newTabClick } from "./new-tab-click";

const click = (button: number, ctrlKey = false) => ({ button, ctrlKey });

describe("newTabClick", () => {
  const opened = (event: ReturnType<typeof click>, type: "aux" | "click") => {
    const calls: string[] = [];
    const handlers = newTabClick(
      () => {
        calls.push("open");
      },
      () => {
        calls.push("new tab");
      },
    );
    (type === "aux" ? handlers.onAuxClick : handlers.onClick)(event);
    return calls;
  };

  it("opens on a click", () => {
    expect(opened(click(0), "click")).toStrictEqual(["open"]);
  });

  it("opens in a new tab on a Ctrl+click, as a link does", () => {
    expect(opened(click(0, true), "click")).toStrictEqual(["new tab"]);
  });

  it("opens in a new tab on a middle click", () => {
    expect(opened(click(1), "aux")).toStrictEqual(["new tab"]);
  });

  it("leaves a right click alone", () => {
    expect(opened(click(2), "aux")).toStrictEqual([]);
  });
});
