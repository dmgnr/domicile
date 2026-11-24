import {
  WEBVIEW_EXTERNAL_APP_EVENT,
  WEBVIEW_EXTERNAL_APP_WITHDRAWN_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { useContext, useEffect, useState } from "react";

import { ShellLinksContext } from "./shell-links";

/** A link for an application the page opened, waiting on the user. */
export type ExternalAppRequest = {
  /** The link, such as `zoommtg://zoom.us/join?confno=1`. */
  url: string;
  /** The site that opened it, or `""` for none. */
  origin: string;
  /** Whether `open` may remember the choice for the site. */
  mayRemember: boolean;
  /** Open the link, and with `remember`, its site's links from then on. */
  open: (remember: boolean) => void;
  /** Open nothing. */
  dismiss: () => void;
};

/**
 * The link for an application the page in `view` is waiting to open, if any.
 *
 * `preventDefault()` claims it; the engine dismisses unclaimed ones when
 * dispatch returns (see `WEBVIEW_EXTERNAL_APP_EVENT`). Answering clears it,
 * as does the engine withdrawing it for a newer one. Unmounting answers
 * nothing: the engine opens nothing for a request whose element is gone.
 *
 * A link the shell opens itself (see `ShellLinksContext`) goes to the shell,
 * and the engine opens nothing.
 *
 * `view` is `null` when missing, as React's callback refs provide.
 */
export const useExternalAppRequest = (
  view: HTMLElement | null,
): ExternalAppRequest | undefined => {
  const [request, setRequest] = useState<ExternalAppRequest | undefined>(
    undefined,
  );
  const shellLinks = useContext(ShellLinksContext);

  useEffect(() => {
    if (view === null) {
      return undefined;
    } else {
      const cleared = () => {
        setRequest(undefined);
      };
      const asked = (event: DomicileExternalAppEvent) => {
        event.preventDefault();
        if (shellLinks?.opens(event.url) === true) {
          event.dismiss();
          shellLinks.open(event.url);
        } else {
          setRequest({
            dismiss: () => {
              cleared();
              event.dismiss();
            },
            mayRemember: event.mayRemember,
            open: (remember) => {
              cleared();
              event.open(remember);
            },
            origin: event.origin,
            url: event.url,
          });
        }
      };
      view.addEventListener(WEBVIEW_EXTERNAL_APP_EVENT, asked);
      view.addEventListener(WEBVIEW_EXTERNAL_APP_WITHDRAWN_EVENT, cleared);
      return () => {
        view.removeEventListener(WEBVIEW_EXTERNAL_APP_EVENT, asked);
        view.removeEventListener(WEBVIEW_EXTERNAL_APP_WITHDRAWN_EVENT, cleared);
      };
    }
  }, [shellLinks, view]);

  return request;
};
