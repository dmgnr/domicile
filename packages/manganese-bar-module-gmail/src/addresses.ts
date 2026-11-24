/** Gmail's origin. */
export const GMAIL_ORIGIN = "https://mail.google.com";

/**
 * The app id of the account's Gmail window. One per account, so each account
 * has its own window and a second open reuses it.
 */
export const gmailAppId = (email: string): string => `gmail:${email}`;

/**
 * The account's inbox in a browser window. In a browser profile of its own,
 * the profile's Google sign-in is the account's, so the address names no
 * account; otherwise it picks the account by its address.
 */
export const inboxAddress = (email: string, profile?: string): string =>
  profile === undefined
    ? `${GMAIL_ORIGIN}/mail/?${asUser(email)}`
    : `${GMAIL_ORIGIN}/mail/`;

/**
 * The account's Gmail with a new message open over the inbox, filled in from
 * the `mailto:` link `link`: its recipients, subject and body. Gmail's own
 * handler for `mailto:` links, as a browser registers it.
 */
export const composeAddress = (
  email: string,
  link: string,
  profile?: string,
): string =>
  `${GMAIL_ORIGIN}/mail/?${new URLSearchParams([
    ...(profile === undefined ? [["authuser", email]] : []),
    ["extsrc", "mailto"],
    ["url", link],
  ]).toString()}`;

/**
 * The account's Gmail with draft `message` (its message id) open over the
 * drafts list.
 */
export const draftAddress = (
  email: string,
  message: string,
  profile?: string,
): string =>
  `${inboxAddress(email, profile)}#drafts?${new URLSearchParams({
    compose: message,
  }).toString()}`;

/**
 * Picks the signed-in account by its address. Gmail's `/mail/u/<n>/` takes an
 * account's index, not its address.
 */
const asUser = (email: string): string =>
  new URLSearchParams({ authuser: email }).toString();
