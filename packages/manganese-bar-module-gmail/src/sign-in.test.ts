import { describe, expect, it } from "bun:test";
import { Some } from "@cprussin/option-result";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";

import { consentAddress, REDIRECT } from "./consent";
import {
  answering,
  CLIENT,
  EMAIL,
  heldStorage,
  json,
  TOKEN,
} from "./held-google";
import { signIn } from "./sign-in";
import { storedToken } from "./stored-token";

const STATE = "st4te";

/**
 * A desk whose browser windows are `fake`'s and whose fetches answer from
 * `answers`.
 */
const desk = (
  fake: FakeDomicileHost,
  answers: Parameters<typeof answering>[0],
) => {
  const { browser } = fake.domicile;
  return {
    browser: {
      close: browser.close,
      fetch: answering(answers).domicile.browser.fetch,
      on: browser.on,
      open: browser.open,
      get windows() {
        return browser.windows;
      },
    },
  };
};

/** Sends the consent window, the first one opened, to `address`. */
const redirect = (fake: FakeDomicileHost, address: string) => {
  fake.set({
    browserWindows: (fake.host.browserWindows ?? []).map((window) =>
      window.id === "1" ? { ...window, url: address } : window,
    ),
  });
};

describe("signIn", () => {
  it("stores the refresh token Google's consent gets, and closes its window", async () => {
    const fake = new FakeDomicileHost();
    const storage = heldStorage();

    const signedIn = signIn(
      desk(fake, { [TOKEN]: [json(200, { refresh_token: "r" })] }),
      CLIENT,
      EMAIL,
      undefined,
      storage,
      STATE,
    );
    redirect(fake, `${REDIRECT}?state=other&code=n0pe`);
    redirect(fake, `${REDIRECT}?state=${STATE}&code=c0de`);
    await signedIn;

    expect(fake.calls).toStrictEqual([
      ["openBrowserWindow", consentAddress(CLIENT, EMAIL, STATE), "", ""],
      ["closeBrowserWindow", "1"],
    ]);
    expect(storedToken(EMAIL, storage)).toStrictEqual(Some("r"));
  });

  it("fails when Google's consent is refused", async () => {
    const fake = new FakeDomicileHost();

    const signedIn = signIn(
      desk(fake, {}),
      CLIENT,
      EMAIL,
      undefined,
      heldStorage(),
      STATE,
    );
    redirect(fake, `${REDIRECT}?state=${STATE}&error=access_denied`);

    await expect(signedIn).rejects.toThrow("access_denied");
  });

  it("fails when Google gives no refresh token", async () => {
    const fake = new FakeDomicileHost();

    const signedIn = signIn(
      desk(fake, { [TOKEN]: [json(400, { error: "invalid_grant" })] }),
      CLIENT,
      EMAIL,
      undefined,
      heldStorage(),
      STATE,
    );
    redirect(fake, `${REDIRECT}?state=${STATE}&code=c0de`);

    await expect(signedIn).rejects.toThrow("invalid_grant");
  });
});
