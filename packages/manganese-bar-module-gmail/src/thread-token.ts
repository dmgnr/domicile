/** The digits of the base64 text a token encodes, in base64's order. */
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The digits of a token, in base 40. */
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz";

/**
 * The token Gmail's own links name the thread by, as in `#inbox/FMfcg…`, for
 * the Gmail API's hex `threadId`. Gmail opens a thread named this way as a
 * click on it in the list does: beside the inbox when the reading pane is on.
 * Named by the API's id, it opens the thread on its own.
 *
 * The token is `f:<thread id in decimal>`, base64-encoded with its padding
 * dropped, then read as one number in base 64 and written in base 40.
 */
export const threadToken = (threadId: string): string =>
  digits(
    [...btoa(`f:${BigInt(`0x${threadId}`).toString()}`).replace(/=+$/, "")]
      .map((digit) => BigInt(BASE64.indexOf(digit)))
      .reduce((sum, digit) => sum * 64n + digit, 0n),
    CONSONANTS,
  );

/** `value`'s digits in `alphabet`'s base, most significant first. */
const digits = (value: bigint, alphabet: string): string => {
  const base = BigInt(alphabet.length);
  return value === 0n
    ? ""
    : digits(value / base, alphabet) + alphabet[Number(value % base)];
};
