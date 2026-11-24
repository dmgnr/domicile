import type { Option, Result } from "@cprussin/option-result";
import { Err, None, Ok, Some } from "@cprussin/option-result";

/**
 * A Google Cloud OAuth client of the Desktop app type. Google does not treat
 * a desktop client's secret as secret.
 */
export type GoogleClient = { id: string; secret: string };

/**
 * Where Google sends the browser window after consent: a loopback address, as
 * Google's desktop flow asks. Nothing listens there; the window's address
 * carries the code, and the item reads it from the desk's browser windows.
 */
export const REDIRECT = "http://127.0.0.1:47823/";

/**
 * Read-only access to labels, which carry the inbox's counts, and to message
 * headers, which name a new message's sender and subject. Never bodies. The
 * basic settings, which list the addresses the account sends from. And
 * drafts, so an email link written from an alias starts as a draft from it.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

/**
 * Google's consent page for `email`. It redirects to {@link REDIRECT} with
 * `state` and a code that gets a refresh token.
 */
export const consentAddress = (
  client: GoogleClient,
  email: string,
  state: string,
): string =>
  `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    access_type: "offline",
    client_id: client.id,
    login_hint: email,
    prompt: "consent",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  }).toString()}`;

/**
 * The code a browser window's `address` carries, when it is the redirect for
 * the sign-in `state` names: the code, or the error Google refused with.
 */
export const redirectCode = (
  address: string,
  state: string,
): Option<Result<string, string>> => {
  const url = URL.parse(address);
  if (
    url === null ||
    `${url.origin}${url.pathname}` !== REDIRECT ||
    url.searchParams.get("state") !== state
  ) {
    return None();
  } else {
    const code = url.searchParams.get("code");
    return Some(
      code === null
        ? Err(url.searchParams.get("error") ?? `no code in ${address}`)
        : Ok(code),
    );
  }
};
