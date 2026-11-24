import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * The browser profile whose extensions the tray shows: the profile of the
 * browser page last focused, `engineId` while it is one, or the default
 * profile before any was. `undefined` until the engine lists its profiles.
 *
 * Focusing an app window keeps the last page's profile, so the tray does not
 * change under a click on it.
 *
 * Has the engine list that profile's actions in `domicile.extensions.list`,
 * and click them there.
 */
export const useFocusedProfile = (
  domicile: Pick<Domicile, "browser" | "extensions">,
  engineId: string | undefined,
): BrowserProfile | undefined => {
  const [last, setLast] = useState<string | undefined>(undefined);
  if (engineId !== undefined && engineId !== last) {
    setLast(engineId);
  }
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
  const profile = useSyncExternalStore(subscribe, () => {
    const profiles = domicile.browser.profiles;
    const id =
      last === undefined
        ? undefined
        : domicile.browser.windows?.find((window) => window.id === last)
            ?.profile;
    return (
      profiles?.find((profile) => profile.id === id) ??
      profiles?.find(({ isDefault }) => isDefault)
    );
  });
  const id = profile?.id;
  useEffect(() => {
    if (id !== undefined) {
      domicile.extensions.setProfile(id);
    }
  }, [domicile, id]);
  return profile;
};
