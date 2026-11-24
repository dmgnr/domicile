import { describe, expect, it } from "bun:test";

import { droppedUrl, TabDropKind, tabDropKindOf } from "./tab-drop";

describe("tabDropKindOf", () => {
  it("reads a link as a link", () => {
    expect(tabDropKindOf(["text/uri-list", "text/plain", "text/html"])).toBe(
      TabDropKind.Link,
    );
  });

  it("reads a link carrying a file as an image", () => {
    // A page's image drag carries the image's file beside its address.
    expect(tabDropKindOf(["text/uri-list", "text/html", "Files"])).toBe(
      TabDropKind.Image,
    );
  });

  it("reads text as a search", () => {
    expect(tabDropKindOf(["text/plain", "text/html"])).toBe(TabDropKind.Search);
  });

  it("refuses a drag with nothing to open", () => {
    expect(tabDropKindOf(["Files"])).toBeUndefined();
  });
});

describe("droppedUrl", () => {
  it("opens the first address in a uri list, past its comments", () => {
    expect(
      droppedUrl(
        "# from a page\r\nhttps://a.example/\r\nhttps://b.example/",
        "",
      ),
    ).toBe("https://a.example/");
  });

  it("searches dropped words", () => {
    expect(droppedUrl("", "xdg toplevel drag")).toBe(
      "https://google.com/search?q=xdg%20toplevel%20drag",
    );
  });

  it("opens dropped text that is an address", () => {
    expect(droppedUrl("", " example.com/docs ")).toBe(
      "https://example.com/docs",
    );
  });

  it("opens nothing for blank text", () => {
    expect(droppedUrl("", "  ")).toBeUndefined();
  });
});
