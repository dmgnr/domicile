// The launcher's rows for a query. Each row is an action Enter can take.
//
// Order:
// 1. The tags the word being typed could be, if it starts with `!`. Choosing
//    one fills it in.
// 2. The page a `!` tag's site has for the words, if any.
// 3. The tagged search, if the query has a tag.
// 4. A site, if the query is a URL. A full URL is almost always meant as one.
// 5. Matching applications and bookmarks, as one list.
// 6. A path, if the query is spelled like one.
// 7. Matching files. Applications rank above files because they are asked
//    for more often.
// 8. A Google search for the query, always, as the fallback.
//
// The site and the search each have a private row beside them. `!p` anywhere
// in the query offers only the web rows, all private. `!g` offers only its
// Google search, so Enter searches without a look at the matches.
//
// `typedAddress` decides site vs. search, so this box and a browser window's
// address bar agree.

import type {
  TaggedSearch,
  TaggedSite,
} from "@domicile-desktop/manganese-address/search";
import {
  Engine,
  googleUrl,
  TAGS,
  taggedSearch,
  taggedSite,
} from "@domicile-desktop/manganese-address/search";
import {
  TypedAddressKind,
  typedAddress,
} from "@domicile-desktop/manganese-address/typed-address";
import { fileRow } from "./file-row";
import type { Bookmark, DesktopEntry } from "./found-apps";
import { Launch } from "./launch";

/** The kind of a launcher row. */
export enum ChoiceKind {
  App,
  Bookmark,
  File,
  Site,
  Search,
  Tag,
  TaggedSearch,
  TaggedSite,
}

export const Choice = {
  /** An application from a desktop entry. */
  App: (entry: DesktopEntry) => ({
    entry,
    kind: ChoiceKind.App as const,
  }),
  /** A bookmark. */
  Bookmark: (bookmark: Bookmark) => ({
    kind: ChoiceKind.Bookmark as const,
    ...bookmark,
  }),
  /** A path. A directory ends in `/`. */
  File: (found: string) => ({
    kind: ChoiceKind.File as const,
    row: fileRow(found),
  }),
  /**
   * A web search. The row shows the words rather than the search URL, which
   * is harder to read.
   */
  Search: (query: string, url: string, isPrivate: boolean) => ({
    isPrivate,
    kind: ChoiceKind.Search as const,
    query,
    url,
  }),
  Site: (url: string, isPrivate: boolean) => ({
    isPrivate,
    kind: ChoiceKind.Site as const,
    url,
  }),
  /**
   * A tag the word being typed could be. `engine` is `undefined` for
   * `PRIVATE_TAG`, which picks no site. `line` is the box's text with the tag
   * filled in.
   */
  Tag: (tag: string, engine: Engine | undefined, line: string) => ({
    engine,
    kind: ChoiceKind.Tag as const,
    line,
    tag,
  }),
  /** A search on the site a tag names. */
  TaggedSearch: (search: TaggedSearch, isPrivate: boolean) => ({
    isPrivate,
    kind: ChoiceKind.TaggedSearch as const,
    ...search,
  }),
  /** The page on a tag's site whose name is the words. */
  TaggedSite: (site: TaggedSite, isPrivate: boolean) => ({
    isPrivate,
    kind: ChoiceKind.TaggedSite as const,
    ...site,
  }),
};

export type Choice = ReturnType<(typeof Choice)[keyof typeof Choice]>;

/** A row Enter launches: every row but a tag, which fills in the box. */
export type Launchable = Exclude<Choice, ReturnType<typeof Choice.Tag>>;

/** The tag that makes every row private. */
export const PRIVATE_TAG = "!p";

/**
 * The rows for `query`, given what the host found for it.
 *
 * A tagged query puts the tag's page and search first, since the tag says
 * where the user meant to go. The rows for the line as typed follow, with a
 * Google search rather than a second search on the tag's engine.
 */
export const choicesFor = (
  query: string,
  found: readonly string[],
  apps: readonly DesktopEntry[],
  bookmarks: readonly Bookmark[],
): Choice[] => {
  const words = query.split(/\s+/).filter((word) => word !== "");
  const typed = words.filter((word) => word !== PRIVATE_TAG).join(" ");
  const isPrivate = words.includes(PRIVATE_TAG);
  const tagged = taggedChoicesFor(isPrivate ? typed : query, isPrivate);
  return [
    ...tagsFor(query),
    ...(taggedSearch(query)?.engine === Engine.Google
      ? tagged
      : [
          ...tagged,
          ...(isPrivate
            ? webChoicesFor(typed, true)
            : plainChoicesFor(query, found, apps, bookmarks)),
        ]),
  ];
};

/** The launch for `choice`. */
export const launchOf = (choice: Launchable): Launch => {
  switch (choice.kind) {
    case ChoiceKind.App: {
      return Launch.Ran(choice.entry.command);
    }
    case ChoiceKind.File: {
      return Launch.Opened(choice.row.path);
    }
    case ChoiceKind.Bookmark: {
      return Launch.Browsed(choice.url, false, choice.profile);
    }
    case ChoiceKind.Site:
    case ChoiceKind.Search:
    case ChoiceKind.TaggedSearch:
    case ChoiceKind.TaggedSite: {
      return Launch.Browsed(choice.url, choice.isPrivate);
    }
  }
};

/** The launch for `choice` with Shift: a file asks what to open it with. */
export const openWithOf = (choice: Launchable): Launch =>
  choice.kind === ChoiceKind.File
    ? Launch.OpenedWith(choice.row.path)
    : launchOf(choice);

/**
 * The tags `query`'s last word starts, by tag, leaving out tags the line
 * already has. None once a space ends the word, or once the word is a whole
 * tag after words to search: `kate bush !yt` then searches on Enter, as
 * `!yt kate bush` does.
 */
const tagsFor = (query: string): Choice[] => {
  const words = query.split(/\s+/);
  const typing = words.at(-1) ?? "";
  const isDone =
    isTag(typing) && words.some((word) => word !== "" && !isTag(word));
  return typing.startsWith("!") && !isDone
    ? [...Object.keys(TAGS), PRIVATE_TAG]
        .filter(
          (tag) => tag.startsWith(typing) && !words.slice(0, -1).includes(tag),
        )
        .toSorted()
        .map((tag) =>
          Choice.Tag(
            tag,
            TAGS[tag],
            `${query.slice(0, query.length - typing.length)}${tag} `,
          ),
        )
    : [];
};

/** Whether `word` is a tag, `!p` included. */
const isTag = (word: string): boolean => word in TAGS || word === PRIVATE_TAG;

/** The page and search `query`'s tag names, if any. */
const taggedChoicesFor = (query: string, isPrivate: boolean): Choice[] => {
  const site = taggedSite(query);
  const tagged = taggedSearch(query);
  return [
    ...(site === undefined ? [] : [Choice.TaggedSite(site, isPrivate)]),
    ...(tagged === undefined ? [] : [Choice.TaggedSearch(tagged, isPrivate)]),
  ];
};

/** The site `typed` names, if it is one, then a search for it. */
const webChoicesFor = (typed: string, isPrivate: boolean): Choice[] => {
  const address = typedAddress(typed);
  return address === undefined
    ? []
    : [
        ...(address.kind === TypedAddressKind.Site
          ? [Choice.Site(address.url, isPrivate)]
          : []),
        Choice.Search(typed, googleUrl(typed), isPrivate),
      ];
};

const plainChoicesFor = (
  query: string,
  found: readonly string[],
  apps: readonly DesktopEntry[],
  bookmarks: readonly Bookmark[],
): Choice[] => {
  const typed = query.trim();
  const address = typedAddress(typed);
  const applications = byName(typed, [
    ...apps.map((entry) => Choice.App(entry)),
    ...bookmarks.map((bookmark) => Choice.Bookmark(bookmark)),
  ]);
  const files = found.map((path) => Choice.File(path));
  return address === undefined
    ? [...applications, ...files]
    : [
        ...(address.kind === TypedAddressKind.Site
          ? [Choice.Site(address.url, false), Choice.Site(address.url, true)]
          : []),
        ...applications,
        ...typedPath(typed, found),
        ...files,
        Choice.Search(typed, googleUrl(typed), false),
        Choice.Search(typed, googleUrl(typed), true),
      ];
};

/**
 * Applications and bookmarks merged and ranked as
 * `@domicile-desktop/system-apps` ranks each: prefix matches first, then by
 * name. The sort is stable, so equal names keep the order they came in.
 */
const byName = (
  typed: string,
  choices: readonly (
    | ReturnType<typeof Choice.App>
    | ReturnType<typeof Choice.Bookmark>
  )[],
): Choice[] => {
  const prefix = typed.toLowerCase();
  return choices
    .map((choice) => ({ choice, name: nameOf(choice).toLowerCase() }))
    .toSorted(
      (a, b) =>
        Number(!a.name.startsWith(prefix)) -
          Number(!b.name.startsWith(prefix)) || compared(a.name, b.name),
    )
    .map(({ choice }) => choice);
};

/** Compare by UTF-16 code unit, as the host does. */
const compared = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  } else {
    return a > b ? 1 : 0;
  }
};

const nameOf = (
  choice: ReturnType<typeof Choice.App> | ReturnType<typeof Choice.Bookmark>,
): string => {
  switch (choice.kind) {
    case ChoiceKind.App: {
      return choice.entry.name;
    }
    case ChoiceKind.Bookmark: {
      return choice.name;
    }
  }
};

/**
 * A row for a query that starts with `/`, `./`, `../` or `~/`, unless the host
 * already found that path.
 *
 * Such a query can't be a hostname or a search. It is needed because the host
 * only searches home, so `/etc/hosts` would otherwise be missing.
 */
const typedPath = (typed: string, found: readonly string[]): Choice[] => {
  const path = typed.startsWith("~/") ? typed.slice(2) : typed;
  const isFound = found.some((each) => fileRow(each).path === path);
  return /^(?:[/.]|~\/)/.test(typed) && !isFound ? [Choice.File(path)] : [];
};
