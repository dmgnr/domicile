import { describe, expect, it } from "bun:test";

import { threadToken } from "./thread-token";

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz";

/** What Gmail reads from a token: the text it encodes. */
const decoded = (token: string): string => {
  const base64 = digits(
    [...token].reduce(
      (sum, letter) => sum * 40n + BigInt(CONSONANTS.indexOf(letter)),
      0n,
    ),
    BASE64,
  );
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
};

/** `value`'s digits in `alphabet`'s base, most significant first. */
const digits = (value: bigint, alphabet: string): string => {
  const base = BigInt(alphabet.length);
  return value === 0n
    ? ""
    : digits(value / base, alphabet) + alphabet[Number(value % base)];
};

describe("threadToken", () => {
  it("names a thread as Gmail's own links do", () => {
    const token = threadToken("18f2a3b4c5d6e7f8");

    expect(token).toStartWith("FMfcg");
    expect(token).toHaveLength(32);
    expect(decoded(token)).toBe(`f:${BigInt("0x18f2a3b4c5d6e7f8").toString()}`);
  });
});
