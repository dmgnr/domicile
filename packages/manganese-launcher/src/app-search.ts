// The launcher's applications and bookmarks, read through the desktop by
// `@domicile-desktop/system-apps`.

import type { Option, Result } from "@cprussin/option-result";
import type { IconTheme } from "@domicile-desktop/manganese-host/followed-icon-theme";
import type { SystemError } from "@domicile-desktop/sdk/system";
import type { IconLookup } from "@domicile-desktop/system-apps/app-icons";
import { appIcons } from "@domicile-desktop/system-apps/app-icons";
import type { AppsDesktop } from "@domicile-desktop/system-apps/apps-desktop";
import { findBookmarks } from "@domicile-desktop/system-apps/bookmark";
import { curlFetch } from "@domicile-desktop/system-apps/curl";
import { appPlaces } from "@domicile-desktop/system-apps/data-dirs";
import type { DesktopEntry as InstalledEntry } from "@domicile-desktop/system-apps/desktop-entry";
import { favicon } from "@domicile-desktop/system-apps/favicon";
import type { Favicons } from "@domicile-desktop/system-apps/favicons";
import { favicons } from "@domicile-desktop/system-apps/favicons";
import { findApps } from "@domicile-desktop/system-apps/find-apps";
import { installedApps } from "@domicile-desktop/system-apps/installed";
import { omitting } from "@domicile-desktop/system-apps/omit";
import type { ApplicationsConfig } from "./applications-config";
import type { Bookmark, DesktopEntry, FoundApps } from "./found-apps";

/** Most applications, and most bookmarks, offered for one query. */
const FOUND = 50;

export type AppSearch = {
  /** Reads what is installed again, then offers the empty box's rows. */
  opening: () => Promise<FoundApps>;
  /** What matches `query`, from what was read on the last opening. */
  search: (query: string) => Promise<FoundApps>;
};

/**
 * A site the launcher offers as an application: it opens or brings up the
 * site's one app window, app `appId`'s, as `domicile open --app --id` does.
 * Drawn with its site's icon.
 */
export type WebApp = {
  appId: string;
  name: string;
  url: string;
  /**
   * The id of the browser profile its window opens in, such as `work`. By
   * default, the one its site opens in.
   */
  profile?: string | undefined;
};

/** What is installed, as read on an opening. */
type Installed = { entries: InstalledEntry[]; icon: IconLookup };

/**
 * Searches the applications installed on the desktop `domicile` reaches, less
 * those `config` omits, and `config`'s bookmarks. Application icons come from
 * the config's icon theme. `webApps` are offered as applications too.
 *
 * Reads desktop entries on {@link AppSearch.opening} only: a read is a system
 * call per file, too slow for every keystroke. Bookmark icons are fetched in
 * the background, so a later search has them.
 */
export const appSearch = (
  domicile: AppsDesktop,
  config: ApplicationsConfig,
  iconTheme: IconTheme,
  icons: Favicons = favicons((url) => favicon(url, curlFetch(domicile))),
  webApps: readonly WebApp[] = [],
): AppSearch => {
  const omits = omitting(config.omit);
  const sites = new Map(webApps.map((app) => [webAppId(app), app.url]));
  let installed: Promise<Installed> | undefined;
  const search = async (query: string): Promise<FoundApps> => {
    icons
      .lookFor([
        ...config.bookmarks.map(({ url }) => url),
        ...webApps.map(({ url }) => url),
      ])
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: surfacing a lookup that broke
        console.error("could not look for bookmarks' icons", error);
      });
    installed ??= read(domicile, omits, iconTheme);
    const { entries, icon } = await installed;
    return {
      apps: await Promise.all(
        findApps([...entries, ...webApps.map(webAppEntry)], query, FOUND).map(
          (entry) => {
            const site = sites.get(entry.id);
            return site === undefined
              ? drawn(entry, icon)
              : {
                  command: entry.command,
                  comment: entry.comment,
                  icon: orUndefined(icons.icon(site)),
                  id: entry.id,
                  name: entry.name,
                  preview: undefined,
                };
          },
        ),
      ),
      bookmarks: findBookmarks(config.bookmarks, query, FOUND).map(
        (bookmark): Bookmark => ({
          ...bookmark,
          icon: orUndefined(icons.icon(bookmark.url)),
        }),
      ),
    };
  };
  return {
    opening: () => {
      installed = read(domicile, omits, iconTheme);
      return search("");
    },
    search,
  };
};

/** The launcher row id of web app `appId`, beside the desktop file IDs. */
export const webAppId = ({ appId }: Pick<WebApp, "appId">): string =>
  `web-app:${appId}`;

/** `app` as a desktop entry would offer it. */
const webAppEntry = (app: WebApp): InstalledEntry => ({
  command: [
    "domicile",
    "open",
    "--app",
    "--id",
    app.appId,
    "--reuse",
    "focus",
    ...(app.profile === undefined ? [] : ["--profile", app.profile]),
    app.url,
  ],
  comment: "",
  exec: "",
  icon: undefined,
  id: webAppId(app),
  mimeTypes: [],
  name: app.name,
  preview: undefined,
  terminal: undefined,
  windowClass: undefined,
  words: app.name.toLowerCase(),
});

const read = async (
  domicile: AppsDesktop,
  omits: (id: string) => boolean,
  iconTheme: IconTheme,
): Promise<Installed> => {
  const { dirs, terminal } = succeeded(await appPlaces(domicile));
  const theme = await iconTheme();
  return {
    // htop and vim, in the desk's terminal when the config names one.
    entries: succeeded(await installedApps(domicile, dirs, terminal)).filter(
      ({ id }) => !omits(id),
    ),
    icon: appIcons(domicile, dirs, ["apps"], { theme }),
  };
};

/** `entry` with its pictures read. */
const drawn = async (
  {
    command,
    comment,
    icon: iconName,
    id,
    name,
    preview: previewName,
  }: InstalledEntry,
  icon: IconLookup,
): Promise<DesktopEntry> => {
  const picture = async (named: string | undefined) =>
    named === undefined ? undefined : orUndefined(succeeded(await icon(named)));
  return {
    command,
    comment,
    icon: await picture(iconName),
    id,
    name,
    preview: await picture(previewName),
  };
};

/** The value, or a throw: a desktop that refuses to read fails the search. */
const succeeded = <T extends NonNullable<unknown>>(
  result: Result<T, SystemError>,
): T =>
  result.match({
    Err: (error) => {
      throw new Error(
        `could not read the installed applications: ${error.message}`,
      );
    },
    Ok: (value) => value,
  });

const orUndefined = <T extends NonNullable<unknown>>(
  option: Option<T>,
): T | undefined =>
  option.match({ None: () => undefined, Some: (value) => value });
