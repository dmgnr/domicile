// The applications and bookmarks the launcher offers, with their pictures.

/** An application a desktop entry offers. */
export type DesktopEntry = {
  /** The desktop file ID: its path under `applications/`, `/` read as `-`. */
  id: string;
  name: string;
  /** What the entry says it is for, or empty for an entry that says nothing. */
  comment: string;
  /** The argv it runs, for the host's `spawn`. */
  command: readonly string[];
  /** The icon it names, as a `data:` URL, or `undefined` for none found. */
  icon: string | undefined;
  /** The picture it names for a launcher's preview, likewise. */
  preview: string | undefined;
};

/** A URL the desk offers by name. */
export type Bookmark = {
  name: string;
  url: string;
  /** The browser profile it opens in, or `undefined` for its site's. */
  profile?: string | undefined;
  /** The icon its site names, as a `data:` URL, or `undefined` for none found. */
  icon: string | undefined;
};

/** What a search for applications offers: the applications and bookmarks. */
export type FoundApps = {
  apps: readonly DesktopEntry[];
  bookmarks: readonly Bookmark[];
};
