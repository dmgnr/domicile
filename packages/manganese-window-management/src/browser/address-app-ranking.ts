import { z } from "zod";

const count = z.coerce.number().int().nonnegative();
const keyOf = (id: string) => `address-app-picks:${id}:v1`;

/** Promote picked apps among matches; keep the search order for ties. */
export const rankAddressApps = <App extends { id: string }>(
  storage: Pick<Storage, "getItem">,
  apps: readonly App[],
): App[] =>
  apps
    .map((app) => ({ app, picks: picksOf(storage, app.id) }))
    .sort((a, b) => b.picks - a.picks)
    .map(({ app }) => app);

export const rememberAddressApp = (
  storage: Pick<Storage, "getItem" | "setItem">,
  id: string,
) => {
  storage.setItem(keyOf(id), String(picksOf(storage, id) + 1));
};

const picksOf = (storage: Pick<Storage, "getItem">, id: string): number => {
  const value = storage.getItem(keyOf(id));
  return value === null ? 0 : count.parse(value);
};
