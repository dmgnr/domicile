import { useCallback, useEffect, useState } from "react";

import type { Report } from "./config-editor";
import type { SettingsHost, WebAgents } from "./host";

/** How often it is read again while shown: the address gets ready. */
const EVERY_MS = 3000;

/**
 * Agents on the web, read again every few seconds and after each sign-out.
 */
export const useWebAgents = (host: SettingsHost, report: Report) => {
  const [webAgents, setWebAgents] = useState<WebAgents | undefined>(undefined);

  const reload = useCallback(() => {
    host
      .webAgents()
      .then(setWebAgents, report("Couldn't read agents on the web"));
  }, [host, report]);

  useEffect(() => {
    reload();
    const reading = setInterval(reload, EVERY_MS);
    return () => {
      clearInterval(reading);
    };
  }, [reload]);

  const signOut = useCallback(
    (client: string, name: string) => {
      host
        .signOutWebAgent(client)
        .then(reload, report(`Couldn't sign ${name} out`));
    },
    [host, reload, report],
  );

  const retry = useCallback(() => {
    host
      .retryWebAgents()
      .then(reload, report("Couldn't ask your desktop to try again"));
  }, [host, reload, report]);

  return { retry, signOut, webAgents };
};
