import type { Result } from "@cprussin/option-result";
import type { Browser } from "@domicile-desktop/sdk/desktop/browser";

import type { GoogleClient } from "./consent";
import { consentAddress, redirectCode } from "./consent";
import { exchangeCode } from "./google-token";
import { storeToken } from "./stored-token";

type Desk = {
  readonly browser: Pick<
    Browser,
    "close" | "fetch" | "on" | "open" | "windows"
  >;
};

/**
 * Signs the account in: opens Google's consent page in a browser window,
 * reads the code from the window's address once Google redirects it, closes
 * the window, and stores the refresh token the code gets.
 *
 * Rejects when Google refuses the consent or the code. A consent window the
 * user closes leaves the sign-in waiting.
 */
export const signIn = async (
  domicile: Desk,
  client: GoogleClient,
  email: string,
  profile?: string,
  storage?: Parameters<typeof storeToken>[2],
  state: string = randomState(),
): Promise<void> => {
  const { browser } = domicile;
  const code = await new Promise<Result<string, string>>((resolve) => {
    const windowsChanged = () => {
      for (const window of browser.windows ?? []) {
        redirectCode(window.url, state).match({
          None: () => undefined,
          Some: (redirected) => {
            stop();
            browser.close(window.id);
            resolve(redirected);
          },
        });
      }
    };
    const stop = browser.on("change", windowsChanged);
    browser.open(
      consentAddress(client, email, state),
      profile === undefined ? {} : { profile },
    );
  });
  const refreshToken = await code.match({
    Err: (why) => {
      throw new Error(`Google refused the sign-in: ${why}`);
    },
    Ok: (granted) => exchangeCode(domicile, client, granted),
  });
  refreshToken.match({
    Err: (why) => {
      throw new Error(why);
    },
    Ok: (token) => {
      storeToken(email, token, storage);
    },
  });
};

/** A sign-in's own state, so a redirect is matched to its sign-in. */
const randomState = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
