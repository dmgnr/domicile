import { useCallback, useEffect, useState } from "react";

import type { Report } from "./config-editor";
import type { KnownAgents, SettingsHost } from "./host";

/** How often the list is read again while shown: agents come and go. */
const EVERY_MS = 3000;

/**
 * The agents in now and remembered, read again every few seconds and after
 * each stop or forget.
 */
export const useAgents = (host: SettingsHost, report: Report) => {
  const [agents, setAgents] = useState<KnownAgents | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  const reload = useCallback(() => {
    host.agents().then(
      (known) => {
        setAgents(known);
        setFailure(undefined);
      },
      (error: unknown) => {
        setFailure(error);
      },
    );
  }, [host]);

  useEffect(() => {
    reload();
    const reading = setInterval(reload, EVERY_MS);
    return () => {
      clearInterval(reading);
    };
  }, [reload]);

  const stop = useCallback(
    (session: number, agent: string) => {
      host.stopAgent(session).then(reload, report(`Couldn't stop ${agent}`));
    },
    [host, reload, report],
  );

  const forget = useCallback(
    (agent: string) => {
      host.forgetAgent(agent).then(reload, report(`Couldn't forget ${agent}`));
    },
    [host, reload, report],
  );

  return { agents, failure, forget, stop };
};
