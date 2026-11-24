import type { Browser } from "@domicile-desktop/sdk/desktop/browser";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";

import { GMAIL_ORIGIN, gmailAppId, inboxAddress } from "./addresses";
import { threadToken } from "./thread-token";

/** The path of an account's mail page. */
const MAIL_PATH = /^\/mail\/u\/\d+\/$/;

/** The hash of Gmail's inbox. */
const INBOX = "#inbox";

/** How often a press looks for its mail's row in the inbox. */
const LOOK_MS = 500;

/**
 * How long a press looks for its mail's row before opening the mail on its
 * own. Gmail shows its offline copy of the list first, and the new mail joins
 * it once Gmail has synced.
 */
const WAIT_MS = 20_000;

/** The browser {@link openMail} opens Gmail in. */
export type MailBrowser = Pick<
  Browser,
  "clickMatch" | "on" | "openApp" | "windows"
>;

/**
 * Shows the inbox in the account's Gmail window, then, given a `thread` (the
 * Gmail API's hex id), clicks that mail's row in it, as the user would. With
 * Gmail's reading pane on, that shows the mail beside the list: Gmail keeps
 * the address at `#inbox` then, so no address opens that view. It changes
 * only the hash of a running Gmail mail page; loading an address afresh would
 * load all of Gmail again. With no such page open, it loads the inbox first.
 *
 * It looks for the row until it shows, as Gmail brings its list up to date,
 * and stops if the window leaves the inbox or closes. A row that never shows,
 * as for a mail in another tab, opens the mail on its own after
 * {@link WAIT_MS}, saying why with `warn`. Returns a function that stops it.
 * A new window is in browser profile `profile`, or its site's when
 * `undefined`.
 */
export const openMail = (
  browser: MailBrowser,
  email: string,
  thread: string | undefined,
  profile?: string,
  // biome-ignore lint/suspicious/noConsole: a fallback the user sees but cannot tell why
  warn: (message: string) => void = console.warn,
): (() => void) => {
  const id = gmailAppId(email);
  const inProfile = profile === undefined ? {} : { profile };
  const goTo = (started: URL, hash: string) => {
    started.hash = hash;
    browser.openApp(started.href, {
      id,
      reuse: AppReuse.Navigate,
      ...inProfile,
    });
  };
  const show = (started: URL): (() => void) => {
    if (started.hash !== INBOX) {
      goTo(new URL(started), INBOX);
    }
    return thread === undefined
      ? () => undefined
      : clickRow(browser, id, thread, warn, () => {
          goTo(started, `${INBOX}/${threadToken(thread)}`);
        });
  };
  const open = listed(browser, id);
  const started = open === undefined ? undefined : startedAt(open.url);
  if (started === undefined) {
    browser.openApp(inboxAddress(email, profile), {
      id,
      reuse: AppReuse.Navigate,
      ...inProfile,
    });
    return whenStarted(browser, id, show);
  } else {
    return show(started);
  }
};

/**
 * Clicks thread `thread`'s row in window `id`'s inbox once Gmail lists it.
 * Calls `alone` if it never does in {@link WAIT_MS}. Gives up when the window
 * closes, or leaves the inbox after reaching it. Says what went wrong with
 * `warn`. Returns a function that stops it.
 */
const clickRow = (
  browser: MailBrowser,
  id: string,
  thread: string,
  warn: (message: string) => void,
  alone: () => void,
): (() => void) => {
  const row = `tr [data-legacy-thread-id="${thread}"]`;
  const state = { arrived: false, asking: false, warned: false };
  const stop = () => {
    clearInterval(looking);
    clearTimeout(deadline);
  };
  const look = () => {
    const window = listed(browser, id);
    const at = window === undefined ? undefined : URL.parse(window.url)?.hash;
    if (window === undefined || (state.arrived && at !== INBOX)) {
      // Closed, or the user went elsewhere: a click now would take them back.
      stop();
    } else if (at === INBOX && !state.asking) {
      state.arrived = true;
      state.asking = true;
      browser.clickMatch(window.id, row).then(
        (clicked) => {
          state.asking = false;
          if (clicked) {
            stop();
          }
        },
        (error: unknown) => {
          state.asking = false;
          // The page left as it was asked, or the window closed. The next
          // look asks again, or sees where it went and stops. Said once, as
          // each look would say it again.
          if (!state.warned) {
            state.warned = true;
            warn(`Gmail's window gave no answer to a click: ${String(error)}`);
          }
        },
      );
    }
  };
  const looking = setInterval(look, LOOK_MS);
  const deadline = setTimeout(() => {
    stop();
    // A closed window has nothing to open the mail in; opening it would open
    // a new one the user closed.
    if (listed(browser, id) !== undefined) {
      warn(
        `Gmail never listed thread ${thread} in its inbox; opening it alone`,
      );
      alone();
    }
  }, WAIT_MS);
  look();
  return stop;
};

/**
 * Calls `then` with the address of window `id`'s page once Gmail has started
 * in it. Gives up when the window closes after it was listed. Returns a
 * function that stops the wait, and whatever `then` started.
 */
const whenStarted = (
  browser: MailBrowser,
  id: string,
  then: (started: URL) => () => void,
): (() => void) => {
  const watch: { seen: boolean; stopThen: () => void } = {
    seen: listed(browser, id) !== undefined,
    stopThen: () => undefined,
  };
  const stop = browser.on("change", () => {
    const window = listed(browser, id);
    if (window === undefined) {
      // Closed before Gmail started: nothing is left to show it in.
      if (watch.seen) {
        stop();
      }
    } else {
      watch.seen = true;
      const started = startedAt(window.url);
      if (started !== undefined) {
        stop();
        watch.stopThen = then(started);
      }
    }
  });
  return () => {
    stop();
    watch.stopThen();
  };
};

/**
 * The Gmail mail page's address once Gmail has started: it sets a hash, such
 * as `#inbox`, when its app is running. `undefined` before then, such as on
 * the sign-in page or the redirect to `/mail/u/<n>/`, and on Gmail's other
 * apps, such as Chat at `/chat/u/<n>/`.
 */
const startedAt = (url: string): URL | undefined => {
  const parsed = URL.parse(url);
  return parsed?.origin === GMAIL_ORIGIN &&
    MAIL_PATH.test(parsed.pathname) &&
    parsed.hash !== ""
    ? parsed
    : undefined;
};

/** Window `id`, once the browser lists it. */
const listed = (browser: MailBrowser, id: string) =>
  browser.windows?.find(({ appId }) => appId === id);
