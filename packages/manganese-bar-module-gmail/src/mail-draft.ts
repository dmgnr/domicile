/** What a `mailto:` link fills a new message in with (RFC 6068). */
export type MailLink = {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body: string;
};

/**
 * The recipients, subject and body of the `mailto:` link `link`. A `+` is
 * itself, not a space, as in a link and unlike a form. Fields other than
 * these, and a second subject or body, are left out.
 */
export const mailLink = (link: string): MailLink => {
  const [path = "", query = ""] = link
    .replace(/^mailto:/i, "")
    .split(/\?(.*)/s);
  const fields = query
    .split("&")
    .filter((field) => field !== "")
    .map((field) => {
      const [name = "", value = ""] = field.split(/=(.*)/s);
      return [decode(name).toLowerCase(), decode(value)] as const;
    });
  const all = (name: string) =>
    fields
      .filter(([field]) => field === name)
      .flatMap(([, value]) => addresses(value));
  const first = (name: string) =>
    fields.find(([field]) => field === name)?.[1] ?? "";
  return {
    bcc: all("bcc"),
    body: first("body"),
    cc: all("cc"),
    subject: first("subject"),
    to: [...addresses(decode(path)), ...all("to")],
  };
};

/**
 * An RFC 5322 message from `from`, filled in from `link`: plain text, UTF-8,
 * with lines ending in CRLF.
 */
export const draftMessage = (from: string, link: MailLink): string =>
  [
    `From: ${from}`,
    ...header("To", link.to.join(", ")),
    ...header("Cc", link.cc.join(", ")),
    ...header("Bcc", link.bcc.join(", ")),
    ...header("Subject", encodedWords(link.subject)),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    lines(base64(new TextEncoder().encode(crlf(link.body)))),
  ].join("\r\n");

/** Header `name`, unless its `value` is empty. */
const header = (name: string, value: string): string[] =>
  value === "" ? [] : [`${name}: ${value}`];

/** A field's addresses, comma-separated. */
const addresses = (value: string): string[] =>
  value
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");

/** `text` with its percent escapes undone; a broken escape stays as it is. */
const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** `text` as an RFC 2047 encoded word when it isn't plain ASCII. */
const encodedWords = (text: string): string =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${base64(new TextEncoder().encode(text))}?=`;

/** `text` with every line ending as CRLF. */
const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/** `bytes` in base64. */
const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""));

/** Base64 `text` in lines of 76, as MIME wants. */
const lines = (text: string): string =>
  text.match(/.{1,76}/g)?.join("\r\n") ?? "";
