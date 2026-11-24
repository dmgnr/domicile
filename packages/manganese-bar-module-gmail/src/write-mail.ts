import type { Browser } from "@domicile-desktop/sdk/desktop/browser";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";

import { composeAddress, draftAddress, gmailAppId } from "./addresses";
import type { GoogleClient } from "./consent";
import { createDraft } from "./gmail-api";
import { refreshAccess, TokenRefusalKind } from "./google-token";
import { draftMessage, mailLink } from "./mail-draft";
import { storedToken } from "./stored-token";

/** The desktop {@link writeMail} asks Gmail through and opens Gmail in. */
export type WriteDesktop = {
  readonly browser: Pick<Browser, "fetch" | "openApp">;
};

/**
 * Opens the account's Gmail window with a new message, filled in from the
 * `mailto:` link `link`, from address `from`.
 *
 * - From the account's own address: Gmail's new message form over the inbox,
 *   as Gmail's own handler for the link opens it.
 * - From an alias: Gmail's form has no way to name the sender, so the
 *   message starts as a draft from the alias, through the Gmail API, and the
 *   window opens that draft. Should that fail, it says why with `warn` and
 *   opens the form from the account's own address instead, so the link is
 *   never lost.
 *
 * A new window is in browser profile `profile`, or its site's when
 * `undefined`. Resolves once the window is asked to open.
 */
export const writeMail = async (
  domicile: WriteDesktop,
  client: GoogleClient,
  email: string,
  link: string,
  from: string,
  profile?: string,
  storage?: Parameters<typeof storedToken>[1],
  // biome-ignore lint/suspicious/noConsole: a fallback the user sees but cannot tell why
  warn: (message: string) => void = console.warn,
): Promise<void> => {
  const open = (address: string) => {
    domicile.browser.openApp(address, {
      id: gmailAppId(email),
      reuse: AppReuse.Navigate,
      ...(profile === undefined ? {} : { profile }),
    });
  };
  if (from === email) {
    open(composeAddress(email, link, profile));
  } else {
    const drafted = await draftFrom(
      domicile,
      client,
      email,
      link,
      from,
      storage,
    );
    drafted.match({
      Err: (why) => {
        warn(`Gmail could not start an email from ${from}: ${why}`);
        open(composeAddress(email, link, profile));
      },
      Ok: (message) => {
        open(draftAddress(email, message, profile));
      },
    });
  }
};

/** Saves `link`'s message from `from` as a draft; resolves its message id. */
const draftFrom = (
  domicile: WriteDesktop,
  client: GoogleClient,
  email: string,
  link: string,
  from: string,
  storage?: Parameters<typeof storedToken>[1],
) =>
  storedToken(email, storage)
    .okOr(`${email} is signed out`)
    .andThenAsync(async (refreshToken) =>
      (await refreshAccess(domicile, client, refreshToken)).mapErr((refusal) =>
        refusal.kind === TokenRefusalKind.Revoked
          ? `${email} needs to sign in again`
          : refusal.reason,
      ),
    )
    .then((access) =>
      access.andThenAsync(({ token }) =>
        createDraft(domicile, token, draftMessage(from, mailLink(link))),
      ),
    );
