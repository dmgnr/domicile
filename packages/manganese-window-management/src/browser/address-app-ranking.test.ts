import { expect, test } from "bun:test";
import { rankAddressApps, rememberAddressApp } from "./address-app-ranking";

test("promotes a previously picked app without introducing an unrelated match", () => {
  const storage = new Map<string, string>();
  const scores = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const apps = [{ id: "files" }, { id: "editor" }];
  expect(rankAddressApps(scores, apps)).toEqual(apps);
  rememberAddressApp(scores, "editor");
  rememberAddressApp(scores, "terminal");
  expect(rankAddressApps(scores, apps).map(({ id }) => id)).toEqual([
    "editor",
    "files",
  ]);
});
