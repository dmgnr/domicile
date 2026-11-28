import { createContext, useContext, useEffect, useState } from "react";

type AddressApp = {
  icon?: string | undefined;
  launch: (blank?: BlankAddressTab) => void;
  name: string;
};

export type BlankAddressTab = { tab: string; stillBlank: () => boolean };

/** Installed applications the shell offers in its browser address bar. */
export type AddressAppSearch = (
  query: string,
  isPrivate: boolean,
) => Promise<readonly AddressApp[]>;

export const AddressApps = createContext<AddressAppSearch | undefined>(
  undefined,
);
export const LaunchingAddressTab = createContext<string | undefined>(undefined);

/** An old reply must not put app results for another query under the caret. */
export const useAddressApps = (
  query: string | undefined,
  isPrivate: boolean,
): readonly AddressApp[] => {
  const search = useContext(AddressApps);
  const [found, setFound] = useState<
    | {
        apps: readonly AddressApp[];
        isPrivate: boolean;
        query: string;
        search: AddressAppSearch;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (search !== undefined && query !== undefined) {
      let current = true;
      search(query, isPrivate)
        .then((apps) => {
          if (current) {
            setFound({ apps, isPrivate, query, search });
          }
        })
        .catch((error: unknown) => {
          // biome-ignore lint/suspicious/noConsole: report a failed app search while keeping web suggestions usable
          console.error("Could not find apps for the address bar", error);
        });
      return () => {
        current = false;
      };
    } else {
      return undefined;
    }
  }, [isPrivate, query, search]);
  return found !== undefined &&
    found.query === query &&
    found.search === search &&
    found.isPrivate === isPrivate
    ? found.apps
    : [];
};
