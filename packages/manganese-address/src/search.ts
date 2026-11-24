// Search URLs for launcher queries that are neither a file nor a URL.
//
// A bang tag such as `!yt` or `!wiki` anywhere in the query picks the engine;
// untagged queries go to Google. `!g` names Google itself. Tags are often
// appended after the words, so any position counts.
//
// Some tags also resolve names to pages: `!gh cprussin/domicile` opens the
// repository, and the search becomes the second option.

/** Google's search URL; `%QUERY%` stands for the escaped text. */
const GOOGLE = "https://google.com/search?q=%QUERY%";

/** The sites a tag can send a query to. */
export enum Engine {
  GitHub,
  Google,
  GoogleImages,
  GoogleMaps,
  Wikipedia,
  YouTube,
}

/** A query a tag sent to its engine. */
export type TaggedSearch = {
  engine: Engine;
  /** The words, with the tag taken out. */
  query: string;
  url: string;
};

/** How a site a tag names turns a name into one of its pages. */
type Site = {
  shape: RegExp;
  url: string;
};

/** A page on a tagged site, named by the query's single word. */
export type TaggedSite = {
  engine: Engine;
  /** The word, used as the page's path. */
  path: string;
  url: string;
};

/**
 * The tags and the engine each picks.
 *
 * Keys keep the `!` because a bare `yt` may be a search term.
 */
export const TAGS: Readonly<Record<string, Engine>> = {
  "!g": Engine.Google,
  "!gh": Engine.GitHub,
  "!im": Engine.GoogleImages,
  "!maps": Engine.GoogleMaps,
  "!wiki": Engine.Wikipedia,
  "!yt": Engine.YouTube,
};

/** How a query becomes a URL on each engine. */
const ENGINE_URLS: Readonly<Record<Engine, string>> = {
  [Engine.GitHub]: "https://github.com/search?q=%QUERY%",
  [Engine.Google]: GOOGLE,
  [Engine.GoogleImages]: "https://www.google.com/search?q=%QUERY%&tbm=isch",
  [Engine.GoogleMaps]: "https://www.google.com/maps/search/%QUERY%",
  [Engine.Wikipedia]:
    "https://en.wikipedia.org/wiki/Special:Search?search=%QUERY%",
  [Engine.YouTube]: "https://www.youtube.com/results?search_query=%QUERY%",
};

/**
 * Engines whose names map to pages: the name's shape and the page URL, with
 * `%PATH%` standing for the name.
 *
 * GitHub: a user or organization, optionally with a repository. These
 * characters need no URL escaping. Anything else is a search.
 */
const SITES: Readonly<Partial<Record<Engine, Site>>> = {
  [Engine.GitHub]: {
    shape: /^[\w.-]+(?:\/[\w.-]+)?$/,
    url: "https://github.com/%PATH%",
  },
};

/** The URL for `query`: its tag's page, its tag's search, or Google. */
export const searchUrl = (query: string): string =>
  taggedSite(query)?.url ?? taggedSearch(query)?.url ?? googleUrl(query);

/** `query` searched on Google unchanged, tag included. */
export const googleUrl = (query: string): string => urlOf(GOOGLE, query);

/** The search `query`'s tag names, or `undefined` if untagged. */
export const taggedSearch = (query: string): TaggedSearch | undefined => {
  const tag = tagIn(query);
  if (tag === undefined) {
    return undefined;
  } else {
    const engine = engineOf(tag);
    const searched = withoutTag(query, tag);
    return {
      engine,
      query: searched,
      url: urlOf(ENGINE_URLS[engine], searched),
    };
  }
};

/**
 * The page `query`'s tag names, or `undefined` if the tag's site has no pages
 * or the words are not a single name there.
 */
export const taggedSite = (query: string): TaggedSite | undefined => {
  const tag = tagIn(query);
  if (tag === undefined) {
    return undefined;
  } else {
    const engine = engineOf(tag);
    const site = SITES[engine];
    const path = withoutTag(query, tag);
    return site === undefined || !site.shape.test(path)
      ? undefined
      : { engine, path, url: site.url.replace("%PATH%", path) };
  }
};

const engineOf = (tag: string): Engine => {
  const engine = TAGS[tag];
  if (engine === undefined) {
    throw new Error(`launcher: no engine for the tag ${tag}`);
  } else {
    return engine;
  }
};

const urlOf = (template: string, query: string): string =>
  template.replace("%QUERY%", encodeURIComponent(query.trim()));

/**
 * The tag in `query`, or `undefined` if none.
 *
 * Must be a whole word, so `hello!yt world` stays a plain search. The first
 * tag wins.
 */
const tagIn = (query: string): string | undefined =>
  words(query).find((word) => word in TAGS);

/** `query` without the tag, whitespace collapsed. */
const withoutTag = (query: string, tag: string): string =>
  words(query)
    .filter((word) => word !== tag)
    .join(" ");

const words = (query: string): readonly string[] =>
  query.split(/\s+/).filter((word) => word !== "");
