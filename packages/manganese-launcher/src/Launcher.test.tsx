import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ModalDialog } from "@domicile-desktop/component-library/ModalDialog";
import {
  OnOneScreen,
  SCREEN,
} from "@domicile-desktop/manganese-window-management/screens/fixture";
import { FilePreview } from "@domicile-desktop/sdk/file-preview";
import {
  WEBVIEW_FAVICON_CHANGE_EVENT,
  WEBVIEW_GUEST_FOCUS_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { AppWindowIcon } from "@phosphor-icons/react/dist/ssr/AppWindow";
import { BookmarkSimpleIcon } from "@phosphor-icons/react/dist/ssr/BookmarkSimple";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/ssr/GithubLogo";
import { GoogleLogoIcon } from "@phosphor-icons/react/dist/ssr/GoogleLogo";
import { YoutubeLogoIcon } from "@phosphor-icons/react/dist/ssr/YoutubeLogo";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppGlance } from "./app-glance";
import { GlanceTone } from "./app-glance";
import type { Bookmark, DesktopEntry } from "./found-apps";
import { Launcher } from "./Launcher";
import { Launch } from "./launch";
import { learnedIcons, learnIcon } from "./learned-icons";
import { WikipediaLogoIcon } from "./WikipediaLogoIcon";

const FILES = ["Notes/2026/april.org", "Notes/today.org", "src/", "todo.txt"];

/** An installed application, as the host describes it. */
const EDITOR: DesktopEntry = {
  command: ["gedit", "--new-window"],
  comment: "Edit text files",
  icon: undefined,
  id: "org.gnome.gedit.desktop",
  name: "Text Editor",
  preview: undefined,
};

/** An application whose icon the host found. */
const PAINT: DesktopEntry = {
  command: ["paint"],
  comment: "",
  icon: "data:image/png;base64,cm93",
  id: "paint.desktop",
  name: "Paint",
  preview: undefined,
};

/** A bookmark. */
const MAIL: Bookmark = {
  icon: undefined,
  name: "Mail",
  url: "https://mail.example.com",
};

/** Fake host search over `apps` and `bookmarks`, matching every word. */
const searchingApps =
  (apps: readonly DesktopEntry[], bookmarks: readonly Bookmark[]) =>
  (query: string) => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== "");
    const named = (name: string) =>
      words.every((word) => name.toLowerCase().includes(word));
    return Promise.resolve({
      apps: apps.filter((app) => named(app.name)),
      bookmarks: bookmarks.filter((bookmark) => named(bookmark.name)),
    });
  };

/**
 * Fake host search over `files`, returning at most 200 matches like the
 * compositor: every word, any order, any case.
 */
const searching =
  (files: readonly string[], indexing: boolean) => (query: string) => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== "");
    const matched = files.filter((path) =>
      words.every((word) => path.toLowerCase().includes(word)),
    );
    return Promise.resolve({
      files: matched.slice(0, 200),
      indexing,
      matched: matched.length,
    });
  };

/** Paths the panel asked to preview, in order. */
const previewed: string[] = [];

/** Fake host preview: each path's text is its own name. */
const previewing = (path: string) => {
  previewed.push(path);
  return Promise.resolve(holding(path));
};

/** The test home's files. */
const holding = (path: string): FilePreview => {
  if (path === "src") {
    return FilePreview.Directory(["domicile/", "README.md"]);
  } else if (path === "Pictures") {
    return FilePreview.Directory(["cat.png", "2026/", "notes.txt"]);
  } else if (path === "src/main.ts") {
    return FilePreview.Text('const a = "b";');
  } else if (path === "Music/song.flac" || path === "Music/take") {
    return FilePreview.Audio({
      album: "Record",
      artist: "Band",
      cover: "data:image/png;base64,AQID",
      title: "Song",
    });
  } else if (path === "empty") {
    return FilePreview.Directory([]);
  } else if (path.endsWith(".bin") || path === "Music/noise.mp3") {
    return FilePreview.Binary();
  } else {
    return FilePreview.Text(`contents of ${path}`);
  }
};

/** Whether an app opens `path`: every file but a `.kra` one. */
const opensFile = (path: string): Promise<boolean> =>
  Promise.resolve(!path.endsWith(".kra"));

/**
 * Render the open panel over those files, recording launches.
 *
 * Use with `using`, so the panel unmounts when the test returns. `afterEach`
 * is too late: a pending timer could fire in between and update the panel
 * outside `act`.
 */
const launcher = (
  files: readonly string[] = FILES,
  indexing = false,
  apps: readonly DesktopEntry[] = [],
  bookmarks: readonly Bookmark[] = [],
  fromPrivate = false,
  glances: ReadonlyMap<string, AppGlance> = new Map(),
) => {
  previewed.length = 0;
  const launched: Launch[] = [];
  const dismissed: true[] = [];
  const { unmount } = render(
    <Launcher
      fromPrivate={fromPrivate}
      glances={glances}
      onClosed={() => undefined}
      onDismiss={() => {
        dismissed.push(true);
      }}
      onLaunch={(launch) => {
        launched.push(launch);
      }}
      open
      opening={{ apps, bookmarks }}
      opens={opensFile}
      preview={previewing}
      screen={SCREEN}
      search={searching(files, indexing)}
      searchApps={searchingApps(apps, bookmarks)}
    />,
    { wrapper: OnOneScreen },
  );
  return {
    [Symbol.dispose]: unmount,
    box: () =>
      screen.getByRole("combobox", {
        name: "Open an app, a file, a URL, or search",
      }),
    dismissed,
    launched,
    /** The rows' text, once the host has answered the current query. */
    rows: async () =>
      (await screen.findAllByRole("option")).map((row) => row.textContent),
    user: userEvent.setup(),
  };
};

/** The inner markup of `icon`, without its sizing `<svg>`. */
const glyphOf = (icon: ReactElement): string =>
  new DOMParser().parseFromString(renderToStaticMarkup(icon), "image/svg+xml")
    .documentElement.innerHTML;

/** The preview pane. */
loadEmittedStylesheet(
  document,
  new URL("../styled-system/styles.css", import.meta.url),
);

const previewPane = () => screen.getByRole("region", { name: "Preview" });

// Learned bookmark icons persist, so clear them before each test.
beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("Launcher", () => {
  it("shows nothing at all while it is shut", () => {
    render(
      <Launcher
        fromPrivate={false}
        onClosed={() => undefined}
        onDismiss={() => undefined}
        onLaunch={() => undefined}
        open={false}
        opening={{ apps: [], bookmarks: [] }}
        opens={opensFile}
        preview={previewing}
        screen={SCREEN}
        search={searching(FILES, false)}
        searchApps={searchingApps([], [])}
      />,
      { wrapper: OnOneScreen },
    );

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says when it has finished closing", async () => {
    const props = {
      fromPrivate: false,
      onDismiss: () => undefined,
      onLaunch: () => undefined,
      opening: { apps: [], bookmarks: [] },
      opens: opensFile,
      preview: previewing,
      screen: SCREEN,
      search: searching(FILES, false),
      searchApps: searchingApps([], []),
    };
    const closed: true[] = [];
    const onClosed = () => {
      closed.push(true);
    };
    const { rerender } = render(
      <Launcher {...props} onClosed={onClosed} open />,
      { wrapper: OnOneScreen },
    );
    rerender(<Launcher {...props} onClosed={onClosed} open={false} />);

    await waitFor(() => {
      expect(closed).toEqual([true]);
    });
  });

  // Focusing a browser window's view reads as a click in it, which would move
  // the keyboard to that window. The shell refocuses the focused window.
  it("focuses nothing when it closes, not even what an earlier panel left", async () => {
    const props = {
      fromPrivate: false,
      onClosed: () => undefined,
      onDismiss: () => undefined,
      onLaunch: () => undefined,
      opening: { apps: [], bookmarks: [] },
      opens: opensFile,
      preview: previewing,
      screen: SCREEN,
      search: searching(FILES, false),
      searchApps: searchingApps([], []),
    };
    const Desk = ({
      launcher,
      panel,
    }: {
      launcher: boolean;
      panel: boolean;
    }) => (
      <>
        <button type="button">Other screen</button>
        <button type="button">This screen</button>
        <ModalDialog open={panel} title="Panel">
          Body
        </ModalDialog>
        <Launcher {...props} open={launcher} />
      </>
    );
    const { rerender } = render(<Desk launcher={false} panel={false} />, {
      wrapper: OnOneScreen,
    });
    const other = screen.getByRole("button", { name: "Other screen" });
    other.focus();
    rerender(<Desk launcher={false} panel />);
    await screen.findByRole("dialog");
    rerender(<Desk launcher={false} panel={false} />);
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    screen.getByRole("button", { name: "This screen" }).focus();
    rerender(<Desk launcher panel={false} />);
    await screen.findByRole("combobox");
    rerender(<Desk launcher={false} panel={false} />);
    await waitForElementToBeRemoved(() => screen.queryByRole("combobox"));

    expect(document.activeElement).toBe(document.body);
  });

  it("opens wide enough for roomy rows beside a preview", () => {
    using _panel = launcher();

    expect(screen.getByRole("dialog").getAttribute("data-size")).toBe("xl");
  });

  it("sizes its rows to its own screen, not the page every monitor shares", () => {
    // Otherwise a short screen beside a tall one overflows.
    using _panel = launcher();

    expect(screen.getByRole("listbox").parentElement).toHaveStyle({
      blockSize: "60cqh",
    });
  });

  it("has no footer: the search box is all it draws besides the results", () => {
    using _panel = launcher();

    expect(screen.getByRole("dialog").querySelector("footer")).toBeNull();
    // Still named for screen readers, with no visible title.
    expect(screen.getByRole("dialog", { name: "Open" })).toBeInTheDocument();
  });

  it("offers what the host found, each name under the directory it is in", async () => {
    // Directory and name are separate lines, so `textContent` has no
    // separator.
    using panel = launcher();

    expect(await panel.rows()).toStrictEqual([
      "Notes/2026april.org",
      "Notestoday.org",
      "src",
      "todo.txt",
    ]);
  });

  it("asks the host about what the box says", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "notes");

    expect(await panel.rows()).toStrictEqual([
      "Notes/2026april.org",
      "Notestoday.org",
      "Search for notes",
      "Search for notes in a private browser",
    ]);
  });

  it("names a few site codes in the empty box", () => {
    using panel = launcher();

    expect(panel.box().getAttribute("placeholder")).toBe(
      "Open an app, a file, a URL, or search. Try !yt, !wiki or !gh.",
    );
  });

  it("emboldens the letters typed without widening them", async () => {
    // A stroke, not font weight, so matches don't widen letters and shift the
    // row.
    using panel = launcher();

    await panel.user.type(panel.box(), "notes");
    await panel.rows();
    const lit = screen
      .getAllByText("Notes", { selector: "mark" })
      .map((element) => globalThis.getComputedStyle(element))
      .map((style) => ({
        // happy-dom doesn't compute the stroke, only its paint order.
        paintOrder: style.getPropertyValue("paint-order"),
        weight: style.fontWeight,
      }));

    expect(lit).toStrictEqual([
      { paintOrder: "stroke", weight: "normal" },
      { paintOrder: "stroke", weight: "normal" },
    ]);
  });

  it("offers a URL above the file it names, and a search below both", async () => {
    // The URL ranks first; the same-named file and the search follow.
    using panel = launcher(["example.com"]);

    await panel.user.type(panel.box(), "example.com");

    expect(await panel.rows()).toStrictEqual([
      "Go to https://example.com",
      "Go to https://example.com in a private browser",
      "example.com",
      "Search for example.com",
      "Search for example.com in a private browser",
    ]);
  });

  it("draws the applications it opens onto without waiting on the host", () => {
    const { unmount } = render(
      <Launcher
        fromPrivate={false}
        onClosed={() => undefined}
        onDismiss={() => undefined}
        onLaunch={() => undefined}
        open
        opening={{ apps: [EDITOR], bookmarks: [MAIL] }}
        opens={opensFile}
        preview={previewing}
        screen={SCREEN}
        search={() => new Promise(() => undefined)}
        searchApps={() => new Promise(() => undefined)}
      />,
      { wrapper: OnOneScreen },
    );

    expect(
      screen.getAllByRole("option").map((row) => row.textContent),
    ).toStrictEqual(["Mail", "Text Editor"]);
    unmount();
  });

  it("offers the applications above the files, and a search below both", async () => {
    using panel = launcher(["text.md"], false, [EDITOR]);

    await panel.user.type(panel.box(), "text");

    expect(await panel.rows()).toStrictEqual([
      "Text Editor",
      "text.md",
      "Search for text",
      "Search for text in a private browser",
    ]);
  });

  it("draws an application with the icon its entry names", async () => {
    const panel = launcher([], false, [PAINT]);

    await panel.user.type(panel.box(), "paint");
    const [row] = await screen.findAllByRole("option");

    expect(row?.querySelector("img")?.getAttribute("src")).toBe(PAINT.icon);
  });

  it("draws an application whose icon was not found with a glyph", async () => {
    const panel = launcher([], false, [EDITOR]);

    await panel.user.type(panel.box(), "editor");
    const [row] = await screen.findAllByRole("option");

    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector("svg")?.innerHTML).toBe(
      glyphOf(<AppWindowIcon size={16} />),
    );
  });

  it("runs the application chosen", async () => {
    using panel = launcher([], false, [EDITOR]);

    await panel.user.type(panel.box(), "editor");
    await panel.rows();
    await panel.user.keyboard("{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Ran(["gedit", "--new-window"]),
    ]);
  });

  it("offers a bookmark above the files", async () => {
    using panel = launcher(["mail.txt"], false, [], [MAIL]);

    await panel.user.type(panel.box(), "mail");

    expect(await panel.rows()).toStrictEqual([
      "Mail",
      "mail.txt",
      "Search for mail",
      "Search for mail in a private browser",
    ]);
  });

  it("draws a bookmark with the icon the host found for its site", async () => {
    const icon = "data:image/png;base64,aWNv";
    using panel = launcher([], false, [], [{ ...MAIL, icon }]);

    await panel.user.type(panel.box(), "mail");
    const [row] = await screen.findAllByRole("option");

    expect(row?.querySelector("img")?.getAttribute("src")).toBe(icon);
  });

  it("draws a bookmark whose site's icon was not found with a glyph", async () => {
    using panel = launcher([], false, [], [MAIL]);

    await panel.user.type(panel.box(), "mail");
    const [row] = await screen.findAllByRole("option");

    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector("svg")?.innerHTML).toBe(
      glyphOf(<BookmarkSimpleIcon size={16} />),
    );
  });

  describe("a bookmark's icon learned from its own page", () => {
    // The preview loads with the user's sign-in, so it can find icons an
    // anonymous lookup can't.
    const LEARNED = "https://cdn.example.com/mail-31.ico";

    it("is learned from the page the preview shows", async () => {
      using panel = launcher([], false, [], [MAIL]);

      await panel.user.type(panel.box(), "mail");
      const view = await within(previewPane()).findByTitle(
        "https://mail.example.com",
      );
      Object.defineProperty(view, "url", { value: `${MAIL.url}/inbox` });
      Object.defineProperty(view, "favicon", { value: LEARNED });
      fireEvent(
        view,
        new Event(WEBVIEW_FAVICON_CHANGE_EVENT, { bubbles: true }),
      );

      const [row] = await screen.findAllByRole("option");
      expect(row?.querySelector("img")?.getAttribute("src")).toBe(LEARNED);
    });

    it("is not learned from a page of another site", async () => {
      // A sign-in redirect or followed link is another origin, so its icon is
      // ignored.
      using panel = launcher([], false, [], [MAIL]);

      await panel.user.type(panel.box(), "mail");
      const view = await within(previewPane()).findByTitle(
        "https://mail.example.com",
      );
      Object.defineProperty(view, "url", {
        value: "https://accounts.example.com/signin",
      });
      Object.defineProperty(view, "favicon", { value: LEARNED });
      fireEvent(
        view,
        new Event(WEBVIEW_FAVICON_CHANGE_EVENT, { bubbles: true }),
      );

      const [row] = await screen.findAllByRole("option");
      expect(row?.querySelector("img")).toBeNull();
      expect(learnedIcons()).toStrictEqual({});
    });

    it("is drawn before the host's, from the moment the panel opens", async () => {
      learnIcon(MAIL.url, LEARNED);
      using panel = launcher(
        [],
        false,
        [],
        [{ ...MAIL, icon: "data:image/png;base64,aG9zdA==" }],
      );

      await panel.user.type(panel.box(), "mail");
      const [row] = await screen.findAllByRole("option");

      expect(row?.querySelector("img")?.getAttribute("src")).toBe(LEARNED);
    });

    it("gives way to the host's when it will not load", async () => {
      const host = "data:image/png;base64,aG9zdA==";
      learnIcon(MAIL.url, LEARNED);
      using panel = launcher([], false, [], [{ ...MAIL, icon: host }]);

      await panel.user.type(panel.box(), "mail");
      const [row] = await screen.findAllByRole("option");
      const icon = row?.querySelector("img");
      if (icon === null || icon === undefined) {
        throw new Error("the row drew no icon to fail");
      } else {
        fireEvent.error(icon);
      }

      expect(row?.querySelector("img")?.getAttribute("src")).toBe(host);
    });
  });

  it("draws a picture as itself, without the frame a glyph's tile has", async () => {
    // Logos have their own shape, so they get no frame.
    using panel = launcher([], false, [PAINT]);

    await panel.user.type(panel.box(), "paint");
    const [row] = await screen.findAllByRole("option");
    const picture = row?.querySelector("img")?.parentElement;
    if (picture === null || picture === undefined) {
      throw new Error("the row drew no picture");
    } else {
      // `data-row-tile` marks the framed glyph tile.
      expect(picture.hasAttribute("data-row-tile")).toBe(false);
    }
  });

  it("browses to the bookmark chosen", async () => {
    using panel = launcher([], false, [], [MAIL]);

    await panel.user.type(panel.box(), "mail");
    await panel.rows();
    await panel.user.keyboard("{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://mail.example.com", false),
    ]);
  });

  it("offers a tagged search on its engine above the rows the line gets", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!wiki notes");

    expect(await panel.rows()).toStrictEqual([
      "Search for notes on Wikipedia",
      "Search for !wiki notes",
      "Search for !wiki notes in a private browser",
    ]);
  });

  it("offers the page a !gh name goes to, then a search for it on GitHub", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!gh cprussin");

    expect(await panel.rows()).toStrictEqual([
      "Go to cprussin on GitHub",
      "Search for cprussin on GitHub",
      "Search for !gh cprussin",
      "Search for !gh cprussin in a private browser",
    ]);
  });

  it("offers only private rows for a line with !p", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!p !gh cprussin");

    expect(await panel.rows()).toStrictEqual([
      "Go to cprussin on GitHub in a private browser",
      "Search for cprussin on GitHub in a private browser",
      "Search for !gh cprussin in a private browser",
    ]);
  });

  describe("a tag being typed", () => {
    it("lists the tags it could be, each with what it does", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "!");

      expect((await panel.rows()).slice(0, 7)).toStrictEqual([
        "!g Search Google",
        "!gh Search GitHub",
        "!im Search Google Images",
        "!maps Search Google Maps",
        "!p Open in a private browser",
        "!wiki Search Wikipedia",
        "!yt Search YouTube",
      ]);
    });

    it("fills in the tag on Enter, Tab or a click, launching nothing", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "kate bush !y{Enter}");
      expect(panel.box()).toHaveValue("kate bush !yt ");

      await panel.user.type(panel.box(), "!wi{Tab}");
      expect(panel.box()).toHaveValue("kate bush !yt !wiki ");

      await panel.user.type(panel.box(), "!");
      await panel.user.click(
        await screen.findByText("Open in a private browser"),
      );
      expect(panel.box()).toHaveValue("kate bush !yt !wiki !p ");
      expect(panel.launched).toStrictEqual([]);
    });

    it("searches on Enter once a tag after the words is whole", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "kate bush !yt{Enter}");

      expect(panel.launched).toStrictEqual([
        Launch.Browsed(
          "https://www.youtube.com/results?search_query=kate%20bush",
          false,
        ),
      ]);
    });

    it("explains the highlighted tag in the preview", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "!yt");

      expect(
        await within(previewPane()).findByText(
          "Add !yt anywhere in what you type to search YouTube instead of Google. Press Enter or Tab to add it.",
        ),
      ).toBeInTheDocument();
    });

    it("explains that !g skips the other matches", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "!g");

      expect(
        await within(previewPane()).findByText(
          "Add !g anywhere in what you type to search Google and skip the other matches. Press Enter or Tab to add it.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("starts with !p when opened from a private browser", () => {
    using panel = launcher(FILES, false, [], [], true);

    expect(panel.box()).toHaveValue("!p ");
  });

  it("goes to a site in a private browser with !p", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!p example.com{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://example.com", true),
    ]);
  });

  it("goes to a site in a private browser from the row beside it", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "example.com");
    await panel.rows();
    await panel.user.keyboard("{ArrowDown}{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://example.com", true),
    ]);
  });

  it.each([
    ["!gh", <GithubLogoIcon key="gh" size={16} />],
    ["!im", <GoogleLogoIcon key="im" size={16} />],
    ["!maps", <GoogleLogoIcon key="maps" size={16} />],
    ["!wiki", <WikipediaLogoIcon key="wiki" size={16} />],
    ["!yt", <YoutubeLogoIcon key="yt" size={16} />],
  ])(
    "draws a %s search with the logo of the site it searches",
    async (tag, logo) => {
      using panel = launcher();

      await panel.user.type(panel.box(), `${tag} kate bush`);
      const [tagged] = await screen.findAllByRole("option");

      expect(tagged?.querySelector("svg")?.innerHTML).toBe(glyphOf(logo));
    },
  );

  it("searches for a name that matched a file, when that row is chosen", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await panel.rows();
    await panel.user.keyboard("{ArrowDown}{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://google.com/search?q=today", false),
    ]);
  });

  it("edits the file that was clicked", async () => {
    using panel = launcher();

    await panel.user.click(
      await screen.findByRole("option", { name: "todo.txt" }),
    );

    expect(panel.launched).toStrictEqual([Launch.Opened("todo.txt")]);
  });

  it("edits a directory without the slash the host marked it with", async () => {
    using panel = launcher();

    await panel.user.click(await screen.findByRole("option", { name: "src" }));

    expect(panel.launched).toStrictEqual([Launch.Opened("src")]);
  });

  it("edits the first match on Enter, which is what typing a name is for", async () => {
    // Ranking lets users type part of a name and press Enter.
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await panel.rows();
    await panel.user.keyboard("{Enter}");

    expect(panel.launched).toStrictEqual([Launch.Opened("Notes/today.org")]);
  });

  it("takes the Enter it launches with from the window it focuses", async () => {
    // The engine forwards a key the page leaves to the window with the
    // keyboard, which the launch has just moved.
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await panel.rows();

    expect(fireEvent.keyDown(panel.box(), { key: "Enter" })).toBe(false);
  });

  it("says when no app opens the file, and launches nothing", async () => {
    using panel = launcher([...FILES, "Art/drawing.kra"]);

    await panel.user.type(panel.box(), "drawing");
    await panel.rows();
    await panel.user.keyboard("{Enter}");

    expect(
      await screen.findByText("No app on this computer can open .kra files."),
    ).toBeVisible();
    expect(panel.launched).toStrictEqual([]);
  });

  it("still asks what to open a file no app opens with, on Shift+Enter", async () => {
    using panel = launcher([...FILES, "Art/drawing.kra"]);

    await panel.user.type(panel.box(), "drawing");
    await panel.rows();
    await panel.user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(panel.launched).toStrictEqual([
      Launch.OpenedWith("Art/drawing.kra"),
    ]);
  });

  it("asks what to open the row with on Shift+Enter", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await panel.rows();
    await panel.user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(panel.launched).toStrictEqual([
      Launch.OpenedWith("Notes/today.org"),
    ]);
  });

  it("edits the row the arrow keys walked to instead", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "notes");
    await panel.rows();
    await panel.user.keyboard("{ArrowDown}{Enter}");

    expect(panel.launched).toStrictEqual([Launch.Opened("Notes/today.org")]);
  });

  it("highlights the first row as it opens", async () => {
    using panel = launcher();
    await panel.rows();

    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("moves the highlight a page with Page Down and Ctrl+D, and back with Page Up and Ctrl+U", async () => {
    // The test DOM has no layout, so a page is one row.
    using panel = launcher();
    await panel.rows();
    const selected = () =>
      screen
        .getAllByRole("option")
        .findIndex((row) => row.getAttribute("aria-selected") === "true");

    await panel.user.keyboard("{PageDown}{Control>}d{/Control}");
    expect(selected()).toBe(2);

    await panel.user.keyboard("{PageUp}{Control>}u{/Control}");
    expect(selected()).toBe(0);
  });

  it("moves the highlight to the row the pointer is over", async () => {
    // The pointer moves the highlight, so Enter takes the hovered row.
    using panel = launcher();
    await panel.rows();

    await panel.user.hover(screen.getByText("todo.txt"));
    await panel.user.keyboard("{Enter}");

    expect(panel.launched).toStrictEqual([Launch.Opened("todo.txt")]);
  });

  it("browses a URL that matched no file", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "example.com{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://example.com", false),
    ]);
  });

  it("searches for words that are neither a file nor a URL", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!yt kate bush{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed(
        "https://www.youtube.com/results?search_query=kate%20bush",
        false,
      ),
    ]);
  });

  it("goes to the repository a !gh name is", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "!gh cprussin/domicile{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Browsed("https://github.com/cprussin/domicile", false),
    ]);
  });

  it("counts how much of the home is still answering", async () => {
    // The match count shows in the box.
    using panel = launcher();

    await panel.user.type(panel.box(), "notes");

    expect(await screen.findByText("2 matched")).toBeInTheDocument();
  });

  describe("the preview", () => {
    it("shows what the highlighted file holds", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "today");

      expect(
        await within(previewPane()).findByText("contents of Notes/today.org"),
      ).toBeInTheDocument();
    });

    it("scrolls with the wheel", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "today");
      await within(previewPane()).findByText("contents of Notes/today.org");
      fireEvent.wheel(previewPane(), { deltaY: 120 });

      expect(previewPane().scrollTop).toBe(120);
    });

    it("lets the pointer into a site, so it can be scrolled", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "example.com");
      const view = await within(previewPane()).findByTitle(
        "https://example.com",
      );

      expect(globalThis.getComputedStyle(view).pointerEvents).not.toBe("none");
    });

    it("gives the keyboard back to the box when a site takes it", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "example.com");
      const view = await within(previewPane()).findByTitle(
        "https://example.com",
      );
      panel.box().blur();
      view.dispatchEvent(
        new Event(WEBVIEW_GUEST_FOCUS_EVENT, { bubbles: true }),
      );

      expect(panel.box()).toHaveFocus();
    });

    it("waits for the typing to settle before it asks", async () => {
      // Avoids a preview load per keystroke.
      using panel = launcher();

      await panel.user.type(panel.box(), "today");
      await within(previewPane()).findByText("contents of Notes/today.org");

      expect(previewed).toStrictEqual(["Notes/today.org"]);
    });

    it("shows the highlighted image as itself, served from home", async () => {
      // The engine serves home at `domicile://home/`, to the shell only.
      using panel = launcher(["Pictures/cat.png"]);

      await panel.user.type(panel.box(), "cat");

      expect(
        (await within(previewPane()).findByRole("img")).getAttribute("src"),
      ).toBe("domicile://home/Pictures/cat.png");
    });

    it("shows the highlighted PDF bare, without the viewer's toolbar or sidebar", async () => {
      // The PDF viewer's toolbar and sidebar would fill the small pane.
      using panel = launcher(["Scratch/DS11_Complete.pdf"]);

      await panel.user.type(panel.box(), "DS11");

      expect(
        (
          await within(previewPane()).findByTitle("DS11_Complete.pdf")
        ).getAttribute("src"),
      ).toBe("domicile://home/Scratch/DS11_Complete.pdf#toolbar=0&navpanes=0");
    });

    it("lights a file's code by what each piece of it is", async () => {
      // Scopes map to the pane's colors, so it works in light and dark mode.
      using panel = launcher(["src/main.ts"]);

      await panel.user.type(panel.box(), "main");

      expect(
        (await within(previewPane()).findByText("const")).getAttribute(
          "data-scope",
        ),
      ).toBe("keyword");
      expect(
        within(previewPane()).getByText('"b"').getAttribute("data-scope"),
      ).toBe("string");
    });

    it("heads a folder with its name and what it holds, folders first", async () => {
      using panel = launcher(["Pictures/"]);

      await panel.user.type(panel.box(), "Pictures");

      expect(
        await within(previewPane()).findByRole("heading", { name: "Pictures" }),
      ).toBeInTheDocument();
      expect(previewPane()).toHaveTextContent("1 folder · 2 files");
      expect(
        within(previewPane())
          .getAllByRole("listitem")
          .map((entry) => entry.textContent),
      ).toStrictEqual(["2026", "cat.png", "notes.txt"]);
    });

    it("draws the pictures in a folder as themselves", async () => {
      using panel = launcher(["Pictures/"]);

      await panel.user.type(panel.box(), "Pictures");

      expect(
        (
          await within(previewPane()).findByRole("img", { name: "cat.png" })
        ).getAttribute("src"),
      ).toBe("domicile://home/Pictures/cat.png");
    });

    it("shows a song by what it says of itself, and offers to play it", async () => {
      using panel = launcher(["Music/song.flac"]);

      await panel.user.type(panel.box(), "song");

      const pane = within(previewPane());
      expect(
        await pane.findByRole("heading", { name: "Song" }),
      ).toBeInTheDocument();
      expect(previewPane()).toHaveTextContent("Band");
      expect(previewPane()).toHaveTextContent("Record");
      expect(
        pane.getByRole("img", { name: "Cover art" }).getAttribute("src"),
      ).toBe("data:image/png;base64,AQID");
      const player = pane.getByLabelText("Play song.flac");
      expect(player.getAttribute("src")).toBe(
        "domicile://home/Music/song.flac",
      );
      // How long it plays, once the engine has read that far.
      Object.defineProperty(player, "duration", { value: 61.5 });
      fireEvent.loadedMetadata(player);
      expect(previewPane()).toHaveTextContent("1:01");
    });

    it("still offers to play a song that says nothing of itself", async () => {
      using panel = launcher(["Music/noise.mp3"]);

      await panel.user.type(panel.box(), "noise");

      expect(
        await within(previewPane()).findByRole("heading", {
          name: "noise.mp3",
        }),
      ).toBeInTheDocument();
      const player = within(previewPane()).getByLabelText("Play noise.mp3");
      // Nor how long it plays.
      Object.defineProperty(player, "duration", {
        value: Number.POSITIVE_INFINITY,
      });
      fireEvent.loadedMetadata(player);
      expect(previewPane()).not.toHaveTextContent(/\d:\d\d|Infinity|NaN/);
    });

    it("shows a song the host heard, whatever its name says", async () => {
      using panel = launcher(["Music/take"]);

      await panel.user.type(panel.box(), "take");

      expect(
        await within(previewPane()).findByLabelText("Play take"),
      ).toBeInTheDocument();
    });

    it("shows a video that does not say how long it is from its start", async () => {
      using panel = launcher(["Videos/clip.webm"]);

      await panel.user.type(panel.box(), "clip");
      const video = await within(previewPane()).findByLabelText("clip.webm");
      Object.defineProperty(video, "duration", {
        value: Number.POSITIVE_INFINITY,
      });
      fireEvent.loadedMetadata(video);

      expect((video as HTMLVideoElement).currentTime).toBe(0);
      expect(previewPane()).not.toHaveTextContent(/\d:\d\d/);
    });

    it("shows a video as a still from a way into it, not playing", async () => {
      // A still, not playing, and not the often-black first frame.
      using panel = launcher(["Videos/clip.mp4"]);

      await panel.user.type(panel.box(), "clip");
      const video = await within(previewPane()).findByLabelText("clip.mp4");
      Object.defineProperty(video, "duration", { value: 100 });
      fireEvent.loadedMetadata(video);

      expect(video).toBeInstanceOf(HTMLVideoElement);
      expect((video as HTMLVideoElement).autoplay).toBe(false);
      expect((video as HTMLVideoElement).currentTime).toBe(10);
      expect(
        await within(previewPane()).findByText("1:40"),
      ).toBeInTheDocument();
    });

    it("shows what the highlighted directory holds", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "src");

      expect(
        await within(previewPane()).findByText("README.md"),
      ).toBeInTheDocument();
    });

    it("says so for a directory with nothing in it", async () => {
      // A blank pane would look like it is still loading.
      using panel = launcher(["empty/"]);

      await panel.user.type(panel.box(), "empty");

      expect(
        await within(previewPane()).findByText("Empty folder"),
      ).toBeInTheDocument();
    });

    it("shows the highlighted site in a private view of its own", async () => {
      // Private, so a page the user only looked at leaves nothing behind.
      using panel = launcher();

      await panel.user.type(panel.box(), "example.com");
      const view = await within(previewPane()).findByTitle(
        "https://example.com",
      );

      expect(view.tagName).toBe("WEBVIEW");
      expect(view.hasAttribute("private")).toBe(true);
    });

    it("shows the highlighted bookmark in a signed-in view of its own", async () => {
      // Not private, so the page has the user's sign-in to learn icons from.
      using panel = launcher([], false, [], [MAIL]);

      await panel.user.type(panel.box(), "mail");
      const view = await within(previewPane()).findByTitle(
        "https://mail.example.com",
      );

      expect(view.tagName).toBe("WEBVIEW");
      expect(view.hasAttribute("private")).toBe(false);
    });

    it("follows the highlight onto a search, in a private view", async () => {
      using panel = launcher();

      await panel.user.type(panel.box(), "today");
      await panel.rows();
      await panel.user.keyboard("{ArrowDown}");

      expect(
        (
          await within(previewPane()).findByTitle(
            "https://google.com/search?q=today",
          )
        ).hasAttribute("private"),
      ).toBe(true);
    });

    it("says what the highlighted application is and what it runs", async () => {
      using panel = launcher([], false, [EDITOR]);

      await panel.user.type(panel.box(), "editor");

      expect(
        await within(previewPane()).findByText("gedit --new-window"),
      ).toBeInTheDocument();
      expect(previewPane()).toHaveTextContent("Text Editor");
      expect(previewPane()).toHaveTextContent("Edit text files");
    });

    describe("of an app it has a glance of", () => {
      const glanced = (glance: AppGlance) =>
        launcher([], false, [PAINT], [], false, new Map([[PAINT.id, glance]]));

      it("tells its account, its state and its newest items instead of what it runs", async () => {
        using panel = glanced({
          account: "me@example.com",
          items: [{ at: "3h", text: "Dinner Friday?", title: "Alex Chen" }],
          status: { text: "3 unread", tone: GlanceTone.Waiting },
        });

        await panel.user.type(panel.box(), "paint");

        const item = await within(previewPane()).findByRole("listitem");
        expect(item).toHaveTextContent("Alex Chen");
        expect(item).toHaveTextContent("Dinner Friday?");
        expect(item).toHaveTextContent("3h");
        expect(previewPane()).toHaveTextContent("Paint");
        expect(previewPane()).toHaveTextContent("me@example.com");
        expect(previewPane()).toHaveTextContent("3 unread");
        expect(within(previewPane()).queryByText("paint")).toBeNull();
      });

      it("tells its state when it has no items, and not what it runs", async () => {
        using panel = glanced({
          account: undefined,
          items: [],
          status: { text: "2 unread", tone: GlanceTone.Waiting },
        });

        await panel.user.type(panel.box(), "paint");

        expect(
          await within(previewPane()).findByText("2 unread"),
        ).toBeInTheDocument();
        expect(previewPane()).toHaveTextContent("Paint");
        expect(within(previewPane()).queryByText("paint")).toBeNull();
      });
    });

    it("shows the highlighted application's icon", async () => {
      const panel = launcher([], false, [PAINT]);

      await panel.user.type(panel.box(), "paint");

      expect(
        (await within(previewPane()).findByText("Paint")).parentElement
          ?.querySelector("img")
          ?.getAttribute("src"),
      ).toBe(PAINT.icon);
    });

    it("shows the picture of itself the highlighted application names", async () => {
      const picture = "data:image/svg+xml;base64,PHN2Zz4=";
      using panel = launcher([], false, [{ ...PAINT, preview: picture }]);

      await panel.user.type(panel.box(), "paint");

      expect(
        (await within(previewPane()).findByRole("img")).getAttribute("src"),
      ).toBe(picture);
    });

    it("is most of its screen tall, so there is room to see what it shows", () => {
      // Relative to the dialog's screen, not the page, which spans every
      // monitor and would overflow a short one.
      using _panel = launcher();

      expect(globalThis.getComputedStyle(previewPane()).blockSize).toBe(
        "60cqh",
      );
    });

    it("says what to do while there is no row to highlight", async () => {
      // A blank pane would look broken.
      using _panel = launcher([]);

      expect(
        await within(previewPane()).findByText("Nothing selected"),
      ).toBeInTheDocument();
    });

    it("names a file it cannot draw, and says why", async () => {
      using panel = launcher(["firmware.bin"]);

      await panel.user.type(panel.box(), "firmware");

      expect(
        await within(previewPane()).findByText("No preview for this file"),
      ).toBeInTheDocument();
      expect(previewPane()).toHaveTextContent("firmware.bin");
    });

    it("keeps the last preview until the highlight settles on another row", async () => {
      // The old preview stays until the next settles, with no flash between.
      using panel = launcher();

      await panel.user.type(panel.box(), "notes");
      await within(previewPane()).findByText(
        "contents of Notes/2026/april.org",
      );
      await panel.user.keyboard("{ArrowDown}");

      expect(previewPane()).toHaveTextContent(
        "contents of Notes/2026/april.org",
      );
      expect(
        await within(previewPane()).findByText("contents of Notes/today.org"),
      ).toBeInTheDocument();
    });

    it("names a file the engine could not draw after all", async () => {
      // The extension is a guess; a failed image shows the placeholder.
      using panel = launcher(["Pictures/cat.png"]);

      await panel.user.type(panel.box(), "cat");
      fireEvent.error(await within(previewPane()).findByRole("img"));

      expect(
        await within(previewPane()).findByText("No preview for this file"),
      ).toBeInTheDocument();
    });
  });

  it("brings the row the arrow keys reached into view", async () => {
    // The highlight must stay visible as the keyboard moves it.
    const scrolled: (string | null)[] = [];
    const scrollIntoView = spyOn(
      Element.prototype,
      "scrollIntoView",
    ).mockImplementation(function (this: Element) {
      scrolled.push(this.textContent);
    });
    using panel = launcher();

    await panel.rows();
    await panel.user.type(panel.box(), "{ArrowDown}");
    scrollIntoView.mockRestore();

    expect(scrolled.at(-1)).toBe("Notestoday.org");
  });

  it("says so while the desktop is still working out what there is", async () => {
    // Without the notice, partial results look complete.
    using _panel = launcher(["src"], true);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still finding your files",
    );
  });

  it("says so under the last row, not under the panel", async () => {
    // The notice sits after the last row.
    using panel = launcher(["src", "Notes/today.org"], true);
    await panel.rows();

    const status = await screen.findByRole("status");

    expect(
      screen.getAllByRole("option").at(-1)?.compareDocumentPosition(status),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(status.compareDocumentPosition(previewPane())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("says nothing about an index that is not being built", async () => {
    // No notice when the index is complete.
    using panel = launcher();
    await panel.rows();

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens a path that is typed whole, index or no index", async () => {
    // A path-like query (`~/`, `/`) needs no index, so it works while
    // indexing.
    using panel = launcher([], true);

    await panel.user.type(panel.box(), "~/Scratch{Enter}");

    expect(panel.launched).toStrictEqual([Launch.Opened("Scratch")]);
  });

  it("draws what the host sent and counts everything it matched", async () => {
    // The host sends only the first matches; the count shows the total.
    const home = Array.from({ length: 500 }, (_, at) => `file-${String(at)}`);
    using panel = launcher(home);

    expect(await panel.rows()).toHaveLength(200);
    expect(screen.getByText("500 matched")).toBeInTheDocument();
  });

  it("keeps the arrow keys inside the rows it drew", async () => {
    // Clamped, not wrapped, so the user doesn't lose their place.
    using panel = launcher();

    await panel.rows();
    await panel.user.keyboard("{ArrowUp}{Enter}");
    await panel.user.keyboard("{ArrowDown>6/}{Enter}");

    expect(panel.launched).toStrictEqual([
      Launch.Opened("Notes/2026/april.org"),
      Launch.Opened("todo.txt"),
    ]);
  });

  it("walks the rows with ctrl+n and ctrl+p as well as the arrow keys", async () => {
    // Emacs/readline navigation keys.
    using panel = launcher();

    await panel.rows();
    await panel.user.keyboard(
      "{Control>}n{/Control}{Control>}n{/Control}{Control>}p{/Control}{Enter}",
    );

    expect(panel.launched).toStrictEqual([Launch.Opened("Notes/today.org")]);
  });

  it("keeps the keyboard in the box on Tab", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await within(previewPane()).findByText("contents of Notes/today.org");
    await panel.user.tab();
    await panel.user.tab({ shift: true });

    expect(panel.box()).toHaveFocus();
  });

  it("keeps the keyboard in the box when the panel is clicked", async () => {
    using panel = launcher();

    await panel.user.type(panel.box(), "today");
    await panel.user.click(
      await within(previewPane()).findByText("contents of Notes/today.org"),
    );

    expect(panel.box()).toHaveFocus();
  });

  it("sits in the middle of the screen", () => {
    using _panel = launcher();

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-placement",
      "center",
    );
  });

  it("says it was dismissed when Escape closes it", async () => {
    // The desktop owns open state, so the panel only reports the dismissal.
    using panel = launcher();

    await panel.user.keyboard("{Escape}");

    expect(panel.dismissed).toStrictEqual([true]);
  });
});
