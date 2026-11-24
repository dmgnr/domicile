import { beforeEach, describe, expect, it } from "bun:test";

import { ORDER_KEY, rememberedKeys, rememberKeys } from "./remembered-keys";

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("the tray's remembered keys", () => {
  it("are none on a machine that has not seen any", () => {
    expect(rememberedKeys(ORDER_KEY)).toStrictEqual([]);
  });

  it("are the keys last written", () => {
    rememberKeys(ORDER_KEY, ["b", "a"]);
    expect(rememberedKeys(ORDER_KEY)).toStrictEqual(["b", "a"]);
  });

  it("ignore a value that is not a list of keys", () => {
    globalThis.localStorage.setItem(ORDER_KEY, '{"a":1}');
    expect(rememberedKeys(ORDER_KEY)).toStrictEqual([]);
    globalThis.localStorage.setItem(ORDER_KEY, "not json");
    expect(rememberedKeys(ORDER_KEY)).toStrictEqual([]);
  });
});
