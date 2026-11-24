import { useEffect, useMemo, useState } from "react";

import type { Report } from "./config-editor";
import type { Extensions } from "./extensions";
import type { InstalledExtension } from "./host";
import type { ExtensionNames } from "./site-groups";

/**
 * Installed extensions by id, listed again on every change. Empty until
 * listed, or when listing fails.
 */
export const useExtensionsById = (
  extensions: Extensions,
  report: Report,
): ReadonlyMap<string, InstalledExtension> => {
  const [byId, setById] = useState<ReadonlyMap<string, InstalledExtension>>(
    new Map(),
  );

  useEffect(() => {
    const reload = () => {
      extensions.list().then((installed) => {
        setById(
          new Map(installed.map((extension) => [extension.id, extension])),
        );
      }, report("Couldn't list extensions"));
    };
    reload();
    return extensions.onChange(reload);
  }, [extensions, report]);

  return byId;
};

/**
 * Installed extensions' names by id, listed again on every change. Empty
 * until listed, or when listing fails, so sites show their origins.
 */
export const useExtensionNames = (
  extensions: Extensions,
  report: Report,
): ExtensionNames => {
  const byId = useExtensionsById(extensions, report);
  return useMemo(
    () => new Map([...byId].map(([id, { name }]) => [id, name])),
    [byId],
  );
};
