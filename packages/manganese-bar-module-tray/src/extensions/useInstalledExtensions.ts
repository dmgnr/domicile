import { watchHost } from "@domicile-desktop/manganese-host/watch-host";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { InstalledExtension } from "@domicile-desktop/sdk/extension";
import { useEffect, useState } from "react";

/**
 * Every installed extension, switched on or off, as the engine last reported
 * them: what the tray's menu lists, switches and configures.
 *
 * Like `useExtensions`: read once per page, and parsed, so a row this shell
 * cannot draw throws rather than drawing a blank one.
 */
export const useInstalledExtensions = (
  domicile: Pick<Domicile, "extensions">,
): readonly InstalledExtension[] => {
  const [installed, setInstalled] = useState<readonly InstalledExtension[]>([]);

  useEffect(() => {
    const { extensions } = domicile;
    return watchHost(
      (changed) => extensions.on("installed", changed),
      () => extensions.installed,
      setInstalled,
    );
  }, [domicile]);

  return installed;
};
