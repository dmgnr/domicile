import { describe, expect, it } from "bun:test";

import { Engine } from "@domicile-desktop/manganese-address/search";
import {
  Choice,
  ChoiceKind,
  choicesFor,
  launchOf,
  openWithOf,
} from "./choices";
import { fileRow } from "./file-row";
import { Launch } from "./launch";

/** A desktop entry, as the host sends it. */
const EDITOR = {
  command: ["gedit", "--new-window"],
  comment: "Edit text files",
  icon: undefined,
  id: "org.gnome.gedit.desktop",
  name: "Text Editor",
  preview: undefined,
};

/** A bookmark, as the host sends it. */
const MAIL = {
  icon: undefined,
  name: "Mail",
  url: "https://mail.example.com",
};

/** Sample file search results. */
const FOUND = ["Notes/", "Notes/today.org", "notes.org"];

const search = (query: string, isPrivate = false) =>
  Choice.Search(
    query,
    `https://google.com/search?q=${encodeURIComponent(query)}`,
    isPrivate,
  );

/** The ordinary search for `query`, then the private one. */
const searches = (query: string) => [search(query), search(query, true)];

describe("choicesFor", () => {
  it("offers only the files for an empty box", () => {
    // An empty query has nothing to search for.
    expect(choicesFor("   ", FOUND, [], [])).toStrictEqual(
      FOUND.map(Choice.File),
    );
  });

  it("offers the files the host found, then a search for the words", () => {
    // The search is the fallback, even when a file matched.
    expect(choicesFor("today", ["Notes/today.org"], [], [])).toStrictEqual([
      Choice.File("Notes/today.org"),
      ...searches("today"),
    ]);
  });

  it("offers a search alone for words no file matched", () => {
    expect(choicesFor("kate bush", [], [], [])).toStrictEqual(
      searches("kate bush"),
    );
  });

  it("puts a URL first, then the files it matched, then a search", () => {
    // `notes.org` is both a domain and a file. The site ranks first. The site
    // and the search are each offered in a private browser too.
    expect(choicesFor("notes.org", ["notes.org"], [], [])).toStrictEqual([
      Choice.Site("https://notes.org", false),
      Choice.Site("https://notes.org", true),
      Choice.File("notes.org"),
      ...searches("notes.org"),
    ]);
  });

  describe("with !p", () => {
    it("offers only the private site and search for the words", () => {
      expect(
        choicesFor("!p notes.org", ["notes.org"], [EDITOR], [MAIL]),
      ).toStrictEqual([
        Choice.Site("https://notes.org", true),
        search("notes.org", true),
      ]);
    });

    it("reads the tag anywhere in the line", () => {
      expect(choicesFor("kate !p bush", [], [], [])).toStrictEqual([
        search("kate bush", true),
      ]);
    });

    it("sends a tagged query to its engine privately", () => {
      expect(choicesFor("!p !yt kate bush", [], [], [])).toStrictEqual([
        Choice.TaggedSearch(
          {
            engine: Engine.YouTube,
            query: "kate bush",
            url: "https://www.youtube.com/results?search_query=kate%20bush",
          },
          true,
        ),
        search("!yt kate bush", true),
      ]);
    });

    it("offers nothing for the tag alone", () => {
      expect(choicesFor(" !p ", FOUND, [EDITOR], [])).toStrictEqual([]);
    });

    it("leaves a !p inside a word alone", () => {
      expect(choicesFor("hello!p", [], [], [])).toStrictEqual(
        searches("hello!p"),
      );
    });
  });

  it("offers a tagged query on its engine first, then the rows it would get anyway", () => {
    // The tagged search ranks first. The rows for the line as typed follow,
    // with a Google search so it doesn't repeat the first row.
    expect(choicesFor("!wiki notes", ["Notes/"], [], [])).toStrictEqual([
      Choice.TaggedSearch(
        {
          engine: Engine.Wikipedia,
          query: "notes",
          url: "https://en.wikipedia.org/wiki/Special:Search?search=notes",
        },
        false,
      ),
      Choice.File("Notes/"),
      ...searches("!wiki notes"),
    ]);
  });

  describe("with !g", () => {
    const google = (query: string, isPrivate: boolean) =>
      Choice.TaggedSearch(
        {
          engine: Engine.Google,
          query,
          url: `https://google.com/search?q=${encodeURIComponent(query)}`,
        },
        isPrivate,
      );

    it("offers only the Google search, skipping the matches", () => {
      expect(
        choicesFor("!g notes.org", ["notes.org"], [EDITOR], [MAIL]),
      ).toStrictEqual([google("notes.org", false)]);
    });

    it("offers only the private Google search with !p", () => {
      expect(choicesFor("!p !g notes.org", [], [], [])).toStrictEqual([
        google("notes.org", true),
      ]);
    });
  });

  it("offers the page a !gh name goes to above the search for it", () => {
    expect(choicesFor("!gh cprussin", [], [], [])).toStrictEqual([
      Choice.TaggedSite(
        {
          engine: Engine.GitHub,
          path: "cprussin",
          url: "https://github.com/cprussin",
        },
        false,
      ),
      Choice.TaggedSearch(
        {
          engine: Engine.GitHub,
          query: "cprussin",
          url: "https://github.com/search?q=cprussin",
        },
        false,
      ),
      ...searches("!gh cprussin"),
    ]);
  });

  describe("a tag being typed", () => {
    it("offers every tag for a bare !, above the rows the line gets", () => {
      expect(choicesFor("!", [], [], [])).toStrictEqual([
        Choice.Tag("!g", Engine.Google, "!g "),
        Choice.Tag("!gh", Engine.GitHub, "!gh "),
        Choice.Tag("!im", Engine.GoogleImages, "!im "),
        Choice.Tag("!maps", Engine.GoogleMaps, "!maps "),
        Choice.Tag("!p", undefined, "!p "),
        Choice.Tag("!wiki", Engine.Wikipedia, "!wiki "),
        Choice.Tag("!yt", Engine.YouTube, "!yt "),
        ...searches("!"),
      ]);
    });

    it("offers the tags the last word starts, filled in after the words", () => {
      expect(choicesFor("kate bush !y", [], [], []).slice(0, 1)).toStrictEqual([
        Choice.Tag("!yt", Engine.YouTube, "kate bush !yt "),
      ]);
    });

    it("leaves out a tag the line already has", () => {
      expect(choicesFor("!p !", [], [], [])[4]).toStrictEqual(
        Choice.Tag("!wiki", Engine.Wikipedia, "!p !wiki "),
      );
      expect(choicesFor("!yt cats !", [], [], []).slice(0, 6)).toStrictEqual([
        Choice.Tag("!g", Engine.Google, "!yt cats !g "),
        Choice.Tag("!gh", Engine.GitHub, "!yt cats !gh "),
        Choice.Tag("!im", Engine.GoogleImages, "!yt cats !im "),
        Choice.Tag("!maps", Engine.GoogleMaps, "!yt cats !maps "),
        Choice.Tag("!p", undefined, "!yt cats !p "),
        Choice.Tag("!wiki", Engine.Wikipedia, "!yt cats !wiki "),
      ]);
    });

    it("offers no tags for a whole tag after words, so Enter searches", () => {
      expect(choicesFor("kate bush !g", [], [], [])).toStrictEqual([
        Choice.TaggedSearch(
          {
            engine: Engine.Google,
            query: "kate bush",
            url: "https://google.com/search?q=kate%20bush",
          },
          false,
        ),
      ]);
      expect(choicesFor("kate bush !yt", [], [], [])[0]?.kind).toBe(
        ChoiceKind.TaggedSearch,
      );
      expect(choicesFor("kate bush !p", [], [], [])[0]?.kind).toBe(
        ChoiceKind.Search,
      );
    });

    it("still offers tags for a whole tag with nothing to search", () => {
      expect(choicesFor("!g", [], [], []).slice(0, 2)).toStrictEqual([
        Choice.Tag("!g", Engine.Google, "!g "),
        Choice.Tag("!gh", Engine.GitHub, "!gh "),
      ]);
    });

    it("offers no tags once the word is done or matches none", () => {
      const kinds = (query: string) =>
        choicesFor(query, [], [], []).map(({ kind }) => kind);
      expect(kinds("!y ")).not.toContain(ChoiceKind.Tag);
      expect(kinds("!zz")).not.toContain(ChoiceKind.Tag);
      expect(kinds("hello!")).not.toContain(ChoiceKind.Tag);
    });
  });

  it("offers a path spelled like one, whether or not the host found it", () => {
    // The host only searches home, so a path-like query gets its own row, on
    // top: it can't be a hostname or a search.
    expect(choicesFor("/etc/hosts", [], [], [])).toStrictEqual([
      Choice.File("/etc/hosts"),
      ...searches("/etc/hosts"),
    ]);
  });

  it("offers the applications above the files, and a search below both", () => {
    expect(choicesFor("text", ["text.md"], [EDITOR], [])).toStrictEqual([
      Choice.App(EDITOR),
      Choice.File("text.md"),
      ...searches("text"),
    ]);
  });

  it("offers the bookmarks among the applications, by name, above the files", () => {
    // Applications and bookmarks share one ranked list.
    const paint = { ...EDITOR, id: "paint.desktop", name: "Paint" };
    expect(
      choicesFor("", ["notes.org"], [paint, EDITOR], [MAIL]),
    ).toStrictEqual([
      Choice.Bookmark(MAIL),
      Choice.App(paint),
      Choice.App(EDITOR),
      Choice.File("notes.org"),
    ]);
  });

  it("puts a name that starts with the query first, application or bookmark", () => {
    const tea = { ...MAIL, name: "Tea Timer", url: "https://tea.example.com" };
    expect(choicesFor("te", [], [EDITOR], [tea]).slice(0, 2)).toStrictEqual([
      Choice.Bookmark(tea),
      Choice.App(EDITOR),
    ]);
    const meter = { ...MAIL, name: "Meter", url: "https://meter.example.com" };
    expect(choicesFor("te", [], [EDITOR], [meter]).slice(0, 2)).toStrictEqual([
      Choice.App(EDITOR),
      Choice.Bookmark(meter),
    ]);
  });

  it("offers the applications for an empty box, above the files", () => {
    expect(choicesFor("", ["notes.org"], [EDITOR], [])).toStrictEqual([
      Choice.App(EDITOR),
      Choice.File("notes.org"),
    ]);
  });

  it("offers a tagged query's rows above the applications", () => {
    expect(choicesFor("!gh text", [], [EDITOR], [])).toStrictEqual([
      Choice.TaggedSite(
        {
          engine: Engine.GitHub,
          path: "text",
          url: "https://github.com/text",
        },
        false,
      ),
      Choice.TaggedSearch(
        {
          engine: Engine.GitHub,
          query: "text",
          url: "https://github.com/search?q=text",
        },
        false,
      ),
      Choice.App(EDITOR),
      ...searches("!gh text"),
    ]);
  });

  it("reads a typed ~/ as the home the host names its answers from", () => {
    // No duplicate when the host found it too.
    expect(choicesFor("~/notes.org", ["notes.org"], [], [])).toStrictEqual([
      Choice.File("notes.org"),
      ...searches("~/notes.org"),
    ]);
  });
});

describe("launchOf", () => {
  it("edits a file, without the slash the host marks a directory with", () => {
    expect(launchOf(Choice.File("Notes/"))).toStrictEqual(
      Launch.Opened("Notes"),
    );
  });

  it("runs an application's command", () => {
    expect(launchOf(Choice.App(EDITOR))).toStrictEqual(
      Launch.Ran(["gedit", "--new-window"]),
    );
  });

  it("browses a bookmark's URL", () => {
    expect(launchOf(Choice.Bookmark(MAIL))).toStrictEqual(
      Launch.Browsed("https://mail.example.com", false),
    );
  });

  it("browses a bookmark in the browser profile it names", () => {
    expect(
      launchOf(Choice.Bookmark({ ...MAIL, profile: "work" })),
    ).toStrictEqual(Launch.Browsed("https://mail.example.com", false, "work"));
  });

  it("browses a site, a tagged one, or any kind of search", () => {
    expect(launchOf(Choice.Site("https://example.com", false))).toStrictEqual(
      Launch.Browsed("https://example.com", false),
    );
    expect(
      launchOf(
        Choice.TaggedSite(
          {
            engine: Engine.GitHub,
            path: "cprussin",
            url: "https://github.com/cprussin",
          },
          false,
        ),
      ),
    ).toStrictEqual(Launch.Browsed("https://github.com/cprussin", false));
    expect(launchOf(search("kate bush"))).toStrictEqual(
      Launch.Browsed("https://google.com/search?q=kate%20bush", false),
    );
    expect(
      launchOf(
        Choice.TaggedSearch(
          {
            engine: Engine.YouTube,
            query: "kate bush",
            url: "https://www.youtube.com/results?search_query=kate%20bush",
          },
          false,
        ),
      ),
    ).toStrictEqual(
      Launch.Browsed(
        "https://www.youtube.com/results?search_query=kate%20bush",
        false,
      ),
    );
  });

  it("browses a private row in a private browser", () => {
    expect(launchOf(Choice.Site("https://example.com", true))).toStrictEqual(
      Launch.Browsed("https://example.com", true),
    );
    expect(launchOf(search("kate bush", true))).toStrictEqual(
      Launch.Browsed("https://google.com/search?q=kate%20bush", true),
    );
  });
});

describe("openWithOf", () => {
  it("asks what to open a file with", () => {
    expect(openWithOf(Choice.File("Notes/today.org"))).toStrictEqual(
      Launch.OpenedWith("Notes/today.org"),
    );
  });

  it("launches any other row as Enter would", () => {
    expect(openWithOf(Choice.App(EDITOR))).toStrictEqual(
      launchOf(Choice.App(EDITOR)),
    );
  });
});

describe("Choice.File", () => {
  it("is the row the host's path draws as", () => {
    expect(Choice.File("Notes/").row).toStrictEqual(fileRow("Notes/"));
  });
});
