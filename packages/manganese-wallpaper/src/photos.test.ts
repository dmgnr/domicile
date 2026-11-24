import { describe, expect, it } from "bun:test";
import { THEMES } from "@domicile-desktop/component-library/theme-core";

import {
  commonsPhoto,
  DEFAULT_WALLPAPERS,
  photoSizes,
  sourceSet,
} from "./photos";

/** Every photograph across all themes. */
const EVERY_PHOTO = THEMES.flatMap((theme) => DEFAULT_WALLPAPERS[theme]);

describe("DEFAULT_WALLPAPERS", () => {
  it("is several photographs for each theme, no two of them the same", () => {
    // A repeated URL would crossfade a photograph into itself, which looks
    // like no change. Unique across themes too, since a photograph suits only
    // one theme.
    for (const theme of THEMES) {
      expect(DEFAULT_WALLPAPERS[theme].length).toBeGreaterThan(1);
    }
    expect(new Set(EVERY_PHOTO).size).toBe(EVERY_PHOTO.length);
  });

  it("is hundreds of photographs for each theme, so a day rarely repeats one", () => {
    for (const theme of THEMES) {
      expect(DEFAULT_WALLPAPERS[theme].length).toBeGreaterThanOrEqual(100);
    }
  });

  it("asks Commons for a named file, encoded, at a width a 4K desktop can use", () => {
    // Titles contain spaces, commas and a typographic apostrophe, which must
    // be encoded to form a valid `img src`.
    for (const photo of EVERY_PHOTO) {
      const url = new URL(photo);

      expect(url.origin).toBe("https://commons.wikimedia.org");
      expect(url.pathname).toStartWith("/wiki/Special:FilePath/");
      expect(url.searchParams.get("width")).toBe("3840");
      expect(photo).not.toInclude(" ");
    }
  });
});

describe("sourceSet", () => {
  it("offers a Commons photograph at each width Commons serves up to the one asked for", () => {
    // Commons rounds any other width up to the next of these, so a smaller
    // screen can take the smaller file and decode a quarter of the pixels.
    expect(sourceSet(commonsPhoto("Sky, at night.jpg"))).toBe(
      [
        "https://commons.wikimedia.org/wiki/Special:FilePath/Sky%2C%20at%20night.jpg?width=1920 1920w",
        "https://commons.wikimedia.org/wiki/Special:FilePath/Sky%2C%20at%20night.jpg?width=3840 3840w",
      ].join(", "),
    );
  });

  it("offers nothing for a photograph from anywhere else", () => {
    // Other servers do not scale on request, so there is one file to take.
    expect(sourceSet("https://example.com/sky.jpg?width=3840")).toBeUndefined();
  });
});

describe("photoSizes", () => {
  it("is as wide as a photograph needs to be to cover the screen", () => {
    // Covering crops a photograph to the screen: a screen taller than 16:9
    // shows a 16:9 photograph wider than the screen itself.
    expect(photoSizes([1920, 1080])).toBe("1920px");
    expect(photoSizes([1920, 1200])).toBe("2134px");
  });

  it("is the whole page's width before the screens are known", () => {
    expect(photoSizes(undefined)).toBe("100vw");
  });
});
