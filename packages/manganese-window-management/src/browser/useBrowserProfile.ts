import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/** The desk's browser profiles and the one a window's page is in. */
export type WindowProfile = {
  /** The page's profile. */
  profile: BrowserProfile;
  /** Every profile, in the config's order. */
  profiles: readonly BrowserProfile[];
};

/**
 * The browser profile browser window `engineId`'s page is in, with the
 * others; `undefined` until the engine lists both, or for a page in none.
 */
export const useBrowserProfile = (
  domicile: Pick<Domicile, "browser">,
  engineId: string,
): WindowProfile | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => {
      const windows = domicile.browser.on("change", changed);
      const profiles = domicile.browser.on("profilesChange", changed);
      return () => {
        windows();
        profiles();
      };
    },
    [domicile],
  );
  const profiles = useSyncExternalStore(
    subscribe,
    () => domicile.browser.profiles,
  );
  const id = useSyncExternalStore(
    subscribe,
    () =>
      domicile.browser.windows?.find((window) => window.id === engineId)
        ?.profile,
  );
  const profile = profiles?.find((each) => each.id === id);
  return profiles === undefined || profile === undefined
    ? undefined
    : { profile, profiles };
};

/**
 * The color of the browser profile browser window `engineId`'s page is in,
 * when that is not the default profile; `undefined` for the default one, a
 * page in none, or no browser window. A tab marks its icon with it.
 */
export const useProfileMark = (
  domicile: Pick<Domicile, "browser">,
  engineId: string | undefined,
): string | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => {
      const windows = domicile.browser.on("change", changed);
      const profiles = domicile.browser.on("profilesChange", changed);
      return () => {
        windows();
        profiles();
      };
    },
    [domicile],
  );
  return useSyncExternalStore(subscribe, () => {
    const id =
      engineId === undefined
        ? undefined
        : domicile.browser.windows?.find((window) => window.id === engineId)
            ?.profile;
    const profile = domicile.browser.profiles?.find((each) => each.id === id);
    return profile === undefined || profile.isDefault
      ? undefined
      : profile.color;
  });
};

/** Where a page's site opens, for the profile menu's pins. */
export type PinnedSite = {
  /**
   * The site: the entry of the config's or the user's sites that routes the
   * page, or the page's host when none does.
   */
  site: string;
  /** The id of the profile the site opens in. */
  profile: string;
  /** Whether the config's own sites name it, so only the config moves it. */
  locked: boolean;
};

/**
 * Where `url`'s site opens and whether the user can pin it elsewhere;
 * `undefined` for an address that is no web site, such as a new tab page, and
 * until the engine answers.
 */
export const usePinnedSite = (
  domicile: Pick<Domicile, "browser">,
  url: string,
): PinnedSite | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("profilesChange", changed),
    [domicile],
  );
  const profiles = useSyncExternalStore(
    subscribe,
    () => domicile.browser.profiles,
  );
  // The engine's answer, for the address and profiles it was asked with.
  const [routed, setRouted] = useState<{
    profiles: typeof profiles;
    site: string | undefined;
    url: string;
  }>();
  const host = webHostOf(url);
  useEffect(() => {
    if (host === undefined || profiles === undefined) {
      return;
    }
    let current = true;
    domicile.browser.siteFor(url).then(
      (site) => {
        if (current) {
          setRouted({ profiles, site, url });
        }
      },
      // A page whose address the engine will not route opens in the default
      // profile; there is nothing to pin.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [domicile, host, profiles, url]);
  if (
    host === undefined ||
    profiles === undefined ||
    routed === undefined ||
    routed.url !== url ||
    routed.profiles !== profiles
  ) {
    return undefined;
  }
  const { site } = routed;
  const configured = profiles.find(
    (profile) => site !== undefined && profile.configSites.includes(site),
  );
  const pinned = profiles.find(
    (profile) => site !== undefined && profile.pinnedSites.includes(site),
  );
  const fallback = profiles.find((profile) => profile.isDefault);
  const opensIn = configured ?? pinned ?? fallback;
  return opensIn === undefined
    ? undefined
    : {
        locked: configured !== undefined,
        profile: opensIn.id,
        site: site ?? host,
      };
};

/** `url`'s host when it is a web address, which routing pins by. */
const webHostOf = (url: string): string | undefined => {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && hostname !== ""
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
};

/** One extension in a browser profile, for the profile menu's switches. */
export type ProfileExtension = {
  id: string;
  name: string;
  /** The manifest's icon, as a data URL. */
  icon: string;
  /** Switched on in the profile. */
  enabled: boolean;
  /** The config switches it in the profile, so the user cannot. */
  locked: boolean;
};

/**
 * The extensions in browser profile `profile`, each switched on or off
 * there, named and drawn as the desk's installed extensions are. One the
 * desk does not list yet is left out until it does.
 */
export const useProfileExtensions = (
  domicile: Pick<Domicile, "extensions">,
  profile: BrowserProfile | undefined,
): readonly ProfileExtension[] => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.extensions.on("installed", changed),
    [domicile],
  );
  const installed = useSyncExternalStore(
    subscribe,
    () => domicile.extensions.installed,
  );
  return useMemo(() => {
    if (profile === undefined || installed === undefined) {
      return [];
    }
    return profile.extensions.flatMap((id) => {
      const listed = installed.find((extension) => extension.id === id);
      return listed === undefined
        ? []
        : [
            {
              enabled: profile.enabledExtensions.includes(id),
              icon: listed.icon,
              id,
              locked: profile.lockedExtensions.includes(id),
              name: listed.name,
            },
          ];
    });
  }, [installed, profile]);
};
