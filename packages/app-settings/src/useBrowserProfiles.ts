import { useCallback, useEffect, useState } from "react";

import type { BrowserProfiles, SettingsHost } from "./host";

/**
 * The browser profiles the desktop runs, listed again on every change the
 * host pushes and after each `reload`.
 */
export const useBrowserProfiles = (host: SettingsHost) => {
  const [listed, setListed] = useState<BrowserProfiles | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  const reload = useCallback(() => {
    host.browserProfiles().then(
      (profiles) => {
        setListed(profiles);
        setFailure(undefined);
      },
      (error: unknown) => {
        setFailure(error);
      },
    );
  }, [host]);

  useEffect(() => {
    reload();
    return host.onChange(reload);
  }, [host, reload]);

  return { failure, listed, reload };
};
