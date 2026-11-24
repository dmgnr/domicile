import { describe, expect, it, jest } from "bun:test";
import { Ok } from "@cprussin/option-result";
import { DisplayProvider } from "@domicile-desktop/component-library/DisplayProvider";
import type { Theme } from "@domicile-desktop/component-library/theme-core";
import { THEMES } from "@domicile-desktop/component-library/theme-core";
import { OnOneScreen } from "@domicile-desktop/manganese-window-management/screens/fixture";
import type { Files } from "@domicile-desktop/sdk/desktop/files";
import { act, fireEvent, render } from "@testing-library/react";
import { css } from "../styled-system/css";
import { token } from "../styled-system/tokens";
import type { Order } from "./order";
import { inOrder } from "./order";
import { DEFAULT_WALLPAPERS, WALLPAPER_FALLBACKS } from "./photos";
import { Wallpaper } from "./Wallpaper";

/** For photographs given by web address, which are never read as files. */
const NO_FILES = {
  read: () => Promise.reject(new Error("test: no photograph is a path")),
};

/** How long each photograph shows; one rotation tick. */
const DWELL_MS = 60_000;

/** How long the first photographs have to load before the one from the repository shows. */
const FALLBACK_DELAY_MS = 3000;

/** Crossfade duration in ms. */
const CROSSFADE_MS = Number.parseFloat(token("durations.crossfade")) * 1000;

/**
 * The photograph at `index` in `theme`'s rotation. Tests check positions in
 * the list, not its contents.
 */
const photo = (theme: Theme, index: number): string => {
  const url = DEFAULT_WALLPAPERS[theme][index];
  if (url === undefined) {
    throw new Error(
      `test: the ${theme} rotation has no photograph ${index.toString()}`,
    );
  } else {
    return url;
  }
};

/** The rotation shown in `theme`. */
const rotation = (container: HTMLElement, theme: Theme): Element => {
  const found = container.querySelector(`[data-wallpaper-theme="${theme}"]`);
  if (found === null) {
    throw new Error(`test: there is no ${theme} rotation`);
  } else {
    return found;
  }
};

/** The photographs in `theme`'s rotation with `role`, in document order. */
const layer = (
  container: HTMLElement,
  theme: Theme,
  role: string,
): (string | null)[] =>
  [
    ...rotation(container, theme).querySelectorAll(
      `img[data-wallpaper="${role}"]`,
    ),
  ].map((image) => image.getAttribute("src"));

/** Finishes loading every photograph in `container`. */
const loadPhotos = (container: HTMLElement) => {
  for (const image of container.querySelectorAll("img")) {
    fireEvent.load(image);
  }
};

describe("Wallpaper", () => {
  it("shows the picture an application set instead of the rotation", () => {
    const { container } = render(
      <Wallpaper
        files={NO_FILES}
        order={inOrder}
        picture="blob:sky"
        theme="dark"
      />,
      {
        wrapper: OnOneScreen,
      },
    );

    expect(container.querySelector("[data-wallpaper-theme]")).toBeNull();
    expect(
      [...container.querySelectorAll("img")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual(["blob:sky"]);
  });

  it("rotates the photographs it is given", () => {
    jest.useFakeTimers();
    const photos = {
      dark: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      light: ["https://example.com/c.jpg"],
    };
    const { container } = render(
      <Wallpaper
        files={NO_FILES}
        order={inOrder}
        photos={photos}
        theme="dark"
      />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    expect(layer(container, "dark", "current")).toEqual([
      "https://example.com/a.jpg",
    ]);
    expect(layer(container, "light", "current")).toEqual([
      "https://example.com/c.jpg",
    ]);
    act(() => {
      jest.advanceTimersByTime(DWELL_MS);
    });
    expect(layer(container, "dark", "current")).toEqual([
      "https://example.com/b.jpg",
    ]);
    jest.useRealTimers();
  });

  it("shows the photographs in the order it is given, each time round", () => {
    jest.useFakeTimers();
    // The second pass starts one photograph later.
    const order: Order = (photos, pass) =>
      pass === 0 ? photos : [...photos.slice(1), ...photos.slice(0, 1)];
    const photos = {
      dark: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      light: ["https://example.com/c.jpg"],
    };
    const { container } = render(
      <Wallpaper files={NO_FILES} order={order} photos={photos} theme="dark" />,
      { wrapper: OnOneScreen },
    );
    const shown = [];
    for (let tick = 0; tick < 4; tick++) {
      loadPhotos(container);
      shown.push(...layer(container, "dark", "current"));
      act(() => {
        jest.advanceTimersByTime(DWELL_MS);
      });
    }

    expect(shown).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
      "https://example.com/b.jpg",
      "https://example.com/a.jpg",
    ]);
    jest.useRealTimers();
  });

  it("shows a photograph from a path, read through the files", async () => {
    const files: Pick<Files, "read"> = {
      read: () => Promise.resolve(Ok(new Uint8Array([1]))),
    };
    const photos = { dark: ["/srv/night.jpg"], light: ["/srv/day.jpg"] };
    const { container } = render(
      <Wallpaper files={files} order={inOrder} photos={photos} theme="dark" />,
      { wrapper: OnOneScreen },
    );
    await act(() => Promise.resolve());
    loadPhotos(container);

    expect(layer(container, "dark", "current")[0]).toStartWith("blob:");
  });

  it("starts on the first photograph with only the next one loading", () => {
    // The next photograph mounts a whole step early so it has loaded before it
    // fades in. The rest stay unmounted, so dozens of 4K photographs are not
    // held at once. The other theme's current one mounts too, so a theme
    // switch shows a loaded image.
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    expect(layer(container, "dark", "current")).toEqual([photo("dark", 0)]);
    // The photograph from the repository waits too, until the network is late.
    expect(layer(container, "dark", "waiting")).toEqual([
      WALLPAPER_FALLBACKS.dark,
      photo("dark", 1),
    ]);
    expect(layer(container, "light", "current")).toEqual([photo("light", 0)]);
    expect(layer(container, "light", "waiting")).toEqual([
      WALLPAPER_FALLBACKS.light,
    ]);
  });

  it("holds the other theme's photograph until that theme is shown", () => {
    // A hidden rotation would load a 4K photograph every minute for nothing.
    jest.useFakeTimers();
    const { container, rerender } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    act(() => {
      jest.advanceTimersByTime(DWELL_MS);
    });
    expect(layer(container, "dark", "current")).toEqual([photo("dark", 1)]);
    expect(layer(container, "light", "current")).toEqual([photo("light", 0)]);
    expect(layer(container, "light", "previous")).toEqual([]);

    rerender(<Wallpaper files={NO_FILES} order={inOrder} theme="light" />);
    expect(layer(container, "light", "current")).toEqual([photo("light", 0)]);
    expect(layer(container, "light", "waiting")).toEqual([photo("light", 1)]);
    expect(layer(container, "dark", "waiting")).toEqual([]);
    loadPhotos(container);

    act(() => {
      jest.advanceTimersByTime(DWELL_MS);
    });
    expect(layer(container, "light", "current")).toEqual([photo("light", 1)]);
    expect(layer(container, "dark", "current")).toEqual([photo("dark", 1)]);
    jest.useRealTimers();
  });

  it("shows each theme's rotation only in that theme", () => {
    // Hidden rather than unmounted, so the photographs stay loaded.
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );

    expect(rotation(container, "dark").className).toContain(
      css({ _light: { display: "none" } }),
    );
    expect(rotation(container, "light").className).toContain(
      css({ _light: { display: "contents" }, display: "none" }),
    );
  });

  it("covers each screen and not the gaps between them", () => {
    // Monitors of different sizes leave gaps in the page. A photograph over
    // the whole page would be drawn there too, and cropped to the page's
    // shape rather than each monitor's.
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: ({ children }) => (
          <DisplayProvider
            source={{
              displays: [
                {
                  name: "left",
                  position: [0, 0],
                  scale: 1,
                  size: [1920, 1080],
                },
                {
                  name: "right",
                  position: [1920, 120],
                  scale: 2,
                  size: [2560, 1440],
                },
              ],
              onDisplays: () => () => undefined,
            }}
          >
            {children}
          </DisplayProvider>
        ),
      },
    );
    const screens = [
      ...(container.firstElementChild?.querySelectorAll<HTMLElement>(
        ":scope > *",
      ) ?? []),
    ];

    expect(
      screens.map(({ style: { height, left, top, width } }) => ({
        height,
        left,
        top,
        width,
      })),
    ).toEqual([
      { height: "1080px", left: "0px", top: "0px", width: "1920px" },
      { height: "1440px", left: "1920px", top: "120px", width: "2560px" },
    ]);
    for (const screen of screens) {
      expect(screen.querySelectorAll("img").length).toBe(
        // The current, next and repository photographs of the shown theme,
        // and the current and repository ones of the other.
        5,
      );
    }
  });

  it("fetches each photograph only as wide as its screen needs", () => {
    // A 4K photograph decoded for a 1080p screen holds four times the memory
    // it shows.
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      { wrapper: OnOneScreen },
    );

    const photographs = [
      ...rotation(container, "dark").querySelectorAll("img[srcset]"),
    ];
    expect(photographs.length).toBe(2);
    for (const photograph of photographs) {
      expect(photograph.getAttribute("sizes")).toBe("1920px");
    }
  });

  // Windows hidden behind a tab sit at this depth. A wallpaper above them
  // would show through a window opening or closing in front of one.
  it("sits at the depth a window a tab hides is drawn at", () => {
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );

    expect(container.firstElementChild?.className).toContain(
      css({ zIndex: -2 }),
    );
  });

  it("fades the next photograph in over the one it is leaving", () => {
    // The previous photograph stays opaque underneath while the next fades
    // in, so the background never shows through mid-fade.
    jest.useFakeTimers();
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    act(() => {
      jest.advanceTimersByTime(DWELL_MS);
    });

    expect(layer(container, "dark", "current")).toEqual([photo("dark", 1)]);
    expect(layer(container, "dark", "previous")).toEqual([photo("dark", 0)]);
    jest.useRealTimers();
  });

  it("keeps the photograph on screen when still", () => {
    // Nothing redraws an idle desktop: the minute timer doesn't run.
    jest.useFakeTimers();
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} still theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    act(() => {
      jest.advanceTimersByTime(DWELL_MS * 3);
    });

    expect(layer(container, "dark", "current")).toEqual([photo("dark", 0)]);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("holds the next photograph until the theme wipe is over", () => {
    // A crossfade under the wipe would show through the new theme's frame.
    jest.useFakeTimers();
    const { container, rerender } = render(
      <Wallpaper files={NO_FILES} held order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    loadPhotos(container);

    act(() => {
      jest.advanceTimersByTime(DWELL_MS);
    });
    expect(layer(container, "dark", "current")).toEqual([photo("dark", 0)]);

    rerender(
      <Wallpaper files={NO_FILES} held={false} order={inOrder} theme="dark" />,
    );
    expect(layer(container, "dark", "current")).toEqual([photo("dark", 1)]);
    expect(layer(container, "dark", "previous")).toEqual([photo("dark", 0)]);
    jest.useRealTimers();
  });

  it("comes back round to the first photograph at the end of the rotation", () => {
    // On wrap-around the incoming photograph is earlier in the document, so
    // stacking must come from the role, not document order. Checked per theme
    // because the rotations can differ in length.
    for (const theme of THEMES) {
      jest.useFakeTimers();
      const { container, unmount } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme={theme} />,
        {
          wrapper: OnOneScreen,
        },
      );
      const length = DEFAULT_WALLPAPERS[theme].length;

      // Each photograph loads while it is next.
      for (let tick = 0; tick < length; tick++) {
        loadPhotos(container);
        act(() => {
          jest.advanceTimersByTime(DWELL_MS);
        });
      }

      expect(layer(container, theme, "current")).toEqual([photo(theme, 0)]);
      expect(layer(container, theme, "previous")).toEqual([
        photo(theme, length - 1),
      ]);
      unmount();
      jest.useRealTimers();
    }
  });

  it("puts the one it left away once the fade is over", () => {
    // Each photograph must be transparent before its turn. Otherwise a
    // rotation of two would cut instead of fade. A longer one unmounts it
    // until its next turn comes near.
    for (const theme of THEMES) {
      jest.useFakeTimers();
      const { container, unmount } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme={theme} />,
        {
          wrapper: OnOneScreen,
        },
      );
      loadPhotos(container);

      // Two steps: the fade timer starts in the render after the tick.
      act(() => {
        jest.advanceTimersByTime(DWELL_MS);
      });
      act(() => {
        jest.advanceTimersByTime(CROSSFADE_MS);
      });

      expect(layer(container, theme, "current")).toEqual([photo(theme, 1)]);
      expect(layer(container, theme, "previous")).toEqual([]);
      expect(layer(container, theme, "waiting")).toEqual([
        photo(theme, 2 % DEFAULT_WALLPAPERS[theme].length),
      ]);
      unmount();
      jest.useRealTimers();
    }
  });

  it("fades only the photograph coming in", () => {
    // Other role changes happen under an opaque photograph. A transition on
    // them could draw over the incoming photograph.
    const { container } = render(
      <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
      {
        wrapper: OnOneScreen,
      },
    );
    const image = container.querySelector('img[data-wallpaper="waiting"]');

    expect(image?.className).toContain(
      css({
        '&[data-wallpaper="current"]': {
          transition: "opacity {durations.crossfade} {easings.in-out}",
        },
      }),
    );
  });

  describe("the photograph from the repository", () => {
    // It shows only when the network is slow or down. Shown at once, it would
    // flash on every start before the first photograph loads.

    it("stays hidden while the first photographs load", () => {
      const { container } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
        {
          wrapper: OnOneScreen,
        },
      );

      for (const theme of THEMES) {
        expect(layer(container, theme, "fallback")).toEqual([]);
        expect(layer(container, theme, "waiting")).toContain(
          WALLPAPER_FALLBACKS[theme],
        );
      }
    });

    it("shows under each theme's rotation once the photographs are late", () => {
      jest.useFakeTimers();
      const { container } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
        {
          wrapper: OnOneScreen,
        },
      );

      act(() => {
        jest.advanceTimersByTime(FALLBACK_DELAY_MS - 1);
      });
      expect(layer(container, "dark", "fallback")).toEqual([]);
      act(() => {
        jest.advanceTimersByTime(1);
      });

      for (const theme of THEMES) {
        expect(layer(container, theme, "fallback")).toEqual([
          WALLPAPER_FALLBACKS[theme],
        ]);
      }
      jest.useRealTimers();
    });

    it("shows as soon as a photograph fails to load", () => {
      // Without a network a request fails at once, and the desktop would be
      // blank until the delay ran out.
      const { container } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
        {
          wrapper: OnOneScreen,
        },
      );
      const failed = container.querySelector(`img[src="${photo("dark", 0)}"]`);
      if (failed === null) {
        throw new Error("test: the first photograph is not mounted");
      }
      fireEvent.error(failed);

      for (const theme of THEMES) {
        expect(layer(container, theme, "fallback")).toEqual([
          WALLPAPER_FALLBACKS[theme],
        ]);
      }
    });

    it("fades in", () => {
      // It shows over the bare page, not under another photograph.
      const { container } = render(
        <Wallpaper files={NO_FILES} order={inOrder} theme="dark" />,
        {
          wrapper: OnOneScreen,
        },
      );
      const image = container.querySelector(
        `img[src="${WALLPAPER_FALLBACKS.dark}"]`,
      );

      expect(image?.className).toContain(
        css({
          '&[data-wallpaper="fallback"]': {
            transition: "opacity {durations.crossfade} {easings.in-out}",
          },
        }),
      );
    });
  });
});
