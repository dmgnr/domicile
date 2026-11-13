import type {
  WebViewIdentityAccount,
  WebViewIdentityProvider,
  WebViewIdentityPurpose,
  WebViewIdentityStep,
} from "@domicile-desktop/sdk/webview-element";
import {
  WEBVIEW_IDENTITY_EVENT,
  WEBVIEW_IDENTITY_WITHDRAWN_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { useEffect, useState } from "react";

/**
 * A step of a site's "Sign in with" request, waiting on the user: see
 * `WEBVIEW_IDENTITY_STEPS` for what each shows and takes.
 */
export type IdentityRequest = {
  step: WebViewIdentityStep;
  /** Asked from the page's own button: show it over the page. */
  button: boolean;
  /** The site signing in, such as `medium.com`. */
  site: string;
  purpose: WebViewIdentityPurpose;
  providers: readonly WebViewIdentityProvider[];
  accounts: readonly WebViewIdentityAccount[];
  /** The provider's page about an error, or `""`. */
  errorUrl: string;
  /** Sign in with `accounts[account]`. */
  choose: (account: number) => void;
  /** Open `providers[provider]`'s sign-in page in a browser window. */
  signInToProvider: (provider: number) => void;
  /** Open `errorUrl` in a browser window. */
  moreDetails: () => void;
  /** Close the step, as the user's close. */
  dismiss: () => void;
};

/**
 * The "Sign in with" step the page in `view` is waiting on, if any.
 *
 * Claimed and cleared as `usePromptRequest`'s prompts are: answering or the
 * engine withdrawing it clears it, and the next step replaces it.
 */
export const useIdentityRequest = (
  view: HTMLElement | null,
): IdentityRequest | undefined => {
  const [request, setRequest] = useState<IdentityRequest | undefined>(
    undefined,
  );

  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      const cleared = () => {
        setRequest(undefined);
      };
      const asked = (event: DomicileIdentityEvent) => {
        event.preventDefault();
        setRequest({
          accounts: event.accounts(),
          button: event.button,
          choose: (account) => {
            cleared();
            event.choose(account);
          },
          dismiss: () => {
            cleared();
            event.dismiss();
          },
          errorUrl: event.errorUrl,
          moreDetails: () => {
            cleared();
            event.moreDetails();
          },
          providers: event.providers(),
          purpose: event.purpose,
          signInToProvider: (provider) => {
            cleared();
            event.signInToProvider(provider);
          },
          site: event.site,
          step: event.step,
        });
      };
      view.addEventListener(WEBVIEW_IDENTITY_EVENT, asked);
      view.addEventListener(WEBVIEW_IDENTITY_WITHDRAWN_EVENT, cleared);
      return () => {
        view.removeEventListener(WEBVIEW_IDENTITY_EVENT, asked);
        view.removeEventListener(WEBVIEW_IDENTITY_WITHDRAWN_EVENT, cleared);
      };
    }
  }, [view]);

  return request;
};
