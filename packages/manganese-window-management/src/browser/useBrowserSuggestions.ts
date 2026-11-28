import type { BrowserSuggestion } from "@domicile-desktop/sdk/desktop/browser";
import { useEffect, useState } from "react";

export type Suggest = (query: string) => Promise<readonly BrowserSuggestion[]>;

/** Ask Chromium after a pause, ignoring replies for text no longer present. */
export const useBrowserSuggestions = (
  suggest: Suggest | undefined,
  query: string,
): readonly BrowserSuggestion[] | undefined => {
  const [reply, setReply] = useState<
    | { suggest: Suggest; query: string; rows: readonly BrowserSuggestion[] }
    | undefined
  >(undefined);
  useEffect(() => {
    if (suggest !== undefined && query !== "") {
      let current = true;
      const timer = setTimeout(() => {
        suggest(query)
          .then((rows) => {
            if (current) {
              setReply({ query, rows, suggest });
            }
          })
          .catch((error: unknown) => {
            // biome-ignore lint/suspicious/noConsole: report provider failure; typed navigation stays available
            console.error("Chromium suggestions failed", error);
          });
      }, 120);
      return () => {
        current = false;
        clearTimeout(timer);
      };
    } else {
      return undefined;
    }
  }, [suggest, query]);
  return reply !== undefined &&
    reply.query === query &&
    reply.suggest === suggest
    ? reply.rows
    : undefined;
};
