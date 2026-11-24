import { afterEach, describe, expect, it } from "bun:test";
import { drawAt } from "@domicile-desktop/test-support/popup-layout";

import { pageOf } from "./page-of";

const drawn = (window: string): HTMLElement => {
  const view = document.createElement("webview");
  view.setAttribute("window", window);
  document.body.append(view);
  drawAt(view, { height: 900, width: 1200, x: 200, y: 100 });
  return view;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("pageOf", () => {
  it("is where the window's page is drawn", () => {
    drawn("6");
    drawn("7");

    expect(pageOf(document, "7")).toEqual({
      height: 900,
      width: 1200,
      x: 200,
      y: 100,
    });
  });

  it("is nowhere for a hidden window, such as one on another workspace", () => {
    drawn("7").style.display = "none";

    expect(pageOf(document, "7")).toBeUndefined();
  });

  it("is nowhere for a page in no browser window", () => {
    drawn("7");

    expect(pageOf(document, "")).toBeUndefined();
    expect(pageOf(document, "8")).toBeUndefined();
  });
});
