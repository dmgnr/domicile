// Electron's user agent: the engine's, naming the app and Electron beside
// Chrome, as Electron's GetApplicationUserAgent does.

import type { Engine, EngineBrowser } from "../engine";
import { ELECTRON_VERSION } from "./version";

/** The user agent Electron gives the pages of app `name` at `version`. */
export const electronUserAgent = (
  engine: EngineBrowser,
  name: string,
  version: string,
) => {
  const chrome = /Chrome\/\S+/;
  if (chrome.test(engine.userAgent)) {
    // Electron drops the name's whitespace.
    return engine.userAgent.replace(
      chrome,
      `${name.replaceAll(/\s/g, "")}/${version} Chrome/${engine.chromeVersion} Electron/${ELECTRON_VERSION}`,
    );
  } else {
    throw new Error(
      `the engine's user agent names no Chrome: ${engine.userAgent}`,
    );
  }
};

/**
 * `app.userAgentFallback`: `electron()`'s user agent until the app sets one.
 * `announce` tells the engine, as setting it and `renamed` do.
 */
export const createUserAgentFallback = (
  engine: Pick<Engine, "send">,
  electron: () => string,
) => {
  let own: string | undefined;
  const get = () => own ?? electron();
  const tell = (agent: string) => {
    engine.send({ type: "set_user_agent_fallback", user_agent: agent });
  };
  return {
    announce: () => {
      tell(get());
    },
    get,
    /** The app's name changed, and with it Electron's user agent. */
    renamed: () => {
      if (own === undefined) {
        tell(get());
      }
    },
    // Nothing is Electron's own again, as in Electron.
    set: (agent: string) => {
      own = agent === "" ? undefined : agent;
      tell(get());
    },
  };
};
