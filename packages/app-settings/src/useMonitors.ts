import { useEffect, useState } from "react";

import type { Report } from "./config-editor";
import type { Monitor, SettingsHost } from "./host";

/** The lit monitors, or `undefined` until the desktop says. */
export const useMonitors = (host: SettingsHost, report: Report) => {
  const [monitors, setMonitors] = useState<Monitor[] | undefined>(undefined);

  useEffect(() => {
    host
      .monitors()
      .then(setMonitors, report("Couldn't check which monitors show HDR"));
  }, [host, report]);

  return monitors;
};
