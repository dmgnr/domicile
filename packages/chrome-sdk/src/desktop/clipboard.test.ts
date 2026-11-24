import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { desktop } from "./desktop";

const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

describe("clipboard", () => {
  it("lists nothing until the compositor says", () => {
    expect(
      desktop(new FakeDomicileHost().host).clipboard.entries,
    ).toBeUndefined();
  });

  it("lists the history, with no thumbnail for an empty one, and puts a row back or removes it", () => {
    const fake = new FakeDomicileHost();
    fake.set({
      clipboard: [
        {
          current: true,
          id: 3,
          image: false,
          preview: "hello",
          thumbnail: "",
        },
        {
          current: false,
          id: 2,
          image: true,
          preview: "Image, 3 × 2",
          thumbnail: PICTURE,
        },
      ],
    });
    const { clipboard } = desktop(fake.host);
    clipboard.copy(3);
    clipboard.remove(2);

    expect(clipboard.entries).toStrictEqual([
      {
        current: true,
        id: 3,
        image: false,
        preview: "hello",
        thumbnail: undefined,
      },
      {
        current: false,
        id: 2,
        image: true,
        preview: "Image, 3 × 2",
        thumbnail: PICTURE,
      },
    ]);
    expect(fake.calls).toStrictEqual([
      ["copyClipboardEntry", 3],
      ["removeClipboardEntry", 2],
    ]);
  });

  it("says the history changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).clipboard.on("change", () => {
        resolve(undefined);
      });
    });
    fake.set({ clipboard: [] });

    expect(await changed).toBeUndefined();
  });
});
