import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";

import { gmailAppId, inboxAddress } from "./addresses";
import { EMAIL } from "./held-google";
import type { MailBrowser } from "./open-mail";
import { openMail } from "./open-mail";
import { threadToken } from "./thread-token";

/** How often openMail looks for the row, and how long it waits for it. */
const LOOK_MS = 500;
const WAIT_MS = 20_000;

const INBOX = "https://mail.google.com/mail/u/0/#inbox";
const ROW = 'tr [data-legacy-thread-id="a1"]';

/** A host with the account's Gmail window open at `url`. */
const withGmail = (url: string): FakeDomicileHost => {
  const fake = new FakeDomicileHost();
  fake.openBrowser(url, { appId: gmailAppId(EMAIL), isApp: true });
  return fake;
};

/** Every window's page goes to `url`. */
const load = (fake: FakeDomicileHost, url: string): void => {
  fake.set({
    browserWindows: (fake.host.browserWindows ?? []).map((window) => ({
      ...window,
      url,
    })),
  });
};

const navigations = (fake: FakeDomicileHost) =>
  fake.calls
    .filter(
      ([method, , , reuse]) =>
        method === "openAppWindow" && reuse === "navigate",
    )
    .map(([, url]) => url);

/**
 * `fake`'s browser, whose page has the row of thread `a1` once `rowShows`
 * says so. `clicks` gets each selector clicked.
 */
const clicking = (fake: FakeDomicileHost, rowShows: () => boolean) => {
  const clicks: string[] = [];
  const browser: MailBrowser = {
    clickMatch: (_, selector) => {
      clicks.push(selector);
      return Promise.resolve(rowShows());
    },
    on: fake.domicile.browser.on,
    openApp: fake.domicile.browser.openApp,
    get windows() {
      return fake.domicile.browser.windows;
    },
  };
  return { browser, clicks };
};

/** Lets the timers run `ms`, settling each click as it goes. */
const pass = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= LOOK_MS) {
    jest.advanceTimersByTime(Math.min(LOOK_MS, left));
    await Promise.resolve();
    await Promise.resolve();
  }
};

describe("openMail", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows the open Gmail page's inbox by its hash, as a click in Gmail does", () => {
    const fake = withGmail("https://mail.google.com/mail/u/1/#label/work");

    openMail(fake.domicile.browser, EMAIL, undefined);

    expect(navigations(fake)).toStrictEqual([
      "https://mail.google.com/mail/u/1/#inbox",
    ]);
  });

  it("leaves a page already on its inbox where it is", () => {
    const fake = withGmail(INBOX);

    openMail(fake.domicile.browser, EMAIL, undefined);

    expect(navigations(fake)).toStrictEqual([]);
  });

  it("clicks the mail's row in the inbox, so Gmail shows it beside the list", async () => {
    const fake = withGmail(`${INBOX}/FMfcgOld`);
    const { browser, clicks } = clicking(fake, () => true);

    openMail(browser, EMAIL, "a1");
    load(fake, INBOX);
    await pass(LOOK_MS);

    expect(navigations(fake)).toStrictEqual([INBOX]);
    expect(clicks).toStrictEqual([ROW]);
  });

  it("waits for the row while Gmail brings its list up to date", async () => {
    const fake = withGmail(INBOX);
    const synced = { now: false };
    const { browser, clicks } = clicking(fake, () => synced.now);

    openMail(browser, EMAIL, "a1");
    await pass(3 * LOOK_MS);
    synced.now = true;
    await pass(3 * LOOK_MS);

    expect(clicks.length).toBeGreaterThan(1);
    expect(clicks.length).toBeLessThan(6);
    expect(navigations(fake)).toStrictEqual([]);
  });

  it("opens the mail on its own when its row never shows, and says why", async () => {
    const fake = withGmail(INBOX);
    const { browser } = clicking(fake, () => false);
    const warned: string[] = [];

    openMail(browser, EMAIL, "a1", undefined, (message) => {
      warned.push(message);
    });
    await pass(WAIT_MS);

    expect(navigations(fake)).toStrictEqual([`${INBOX}/${threadToken("a1")}`]);
    expect(warned).toStrictEqual([
      "Gmail never listed thread a1 in its inbox; opening it alone",
    ]);
  });

  it("tries a click the page did not answer again, saying so once", async () => {
    const fake = withGmail(INBOX);
    const tries = { left: 3 };
    const warned: string[] = [];
    const browser: MailBrowser = {
      clickMatch: () => {
        tries.left -= 1;
        return tries.left > 0
          ? Promise.reject(new Error("no answer"))
          : Promise.resolve(true);
      },
      on: fake.domicile.browser.on,
      openApp: fake.domicile.browser.openApp,
      get windows() {
        return fake.domicile.browser.windows;
      },
    };

    openMail(browser, EMAIL, "a1", undefined, (message) => {
      warned.push(message);
    });
    await pass(6 * LOOK_MS);

    expect(tries.left).toBe(0);
    expect(warned).toStrictEqual([
      "Gmail's window gave no answer to a click: Error: no answer",
    ]);
  });

  it("opens nothing when the window closed before the row showed", async () => {
    const fake = withGmail(INBOX);
    const { browser } = clicking(fake, () => false);
    const warned: string[] = [];

    openMail(browser, EMAIL, "a1", undefined, (message) => {
      warned.push(message);
    });
    fake.set({ browserWindows: [] });
    await pass(WAIT_MS);

    expect(navigations(fake)).toStrictEqual([]);
    expect(warned).toStrictEqual([]);
  });

  it("stops looking once the user leaves the inbox", async () => {
    const fake = withGmail(INBOX);
    const { browser, clicks } = clicking(fake, () => false);

    openMail(browser, EMAIL, "a1");
    await pass(LOOK_MS);
    load(fake, `${INBOX.replace("#inbox", "#sent")}`);
    const before = clicks.length;
    await pass(WAIT_MS);

    expect(clicks).toHaveLength(before);
    expect(navigations(fake)).toStrictEqual([]);
  });

  it("stops looking once stopped", async () => {
    const fake = withGmail(INBOX);
    const { browser, clicks } = clicking(fake, () => false);

    openMail(browser, EMAIL, "a1")();
    await pass(WAIT_MS);

    expect(clicks.length).toBeLessThan(2);
    expect(navigations(fake)).toStrictEqual([]);
  });

  it("loads the inbox, then looks for the row once Gmail has started", async () => {
    const fake = withGmail("https://mail.google.com/chat/u/0/#chat/home");
    const { browser, clicks } = clicking(fake, () => true);

    openMail(browser, EMAIL, "a1");
    load(fake, "https://accounts.google.com/signin");
    load(fake, "https://mail.google.com/mail/u/0/");
    load(fake, INBOX);
    await pass(LOOK_MS);

    expect(navigations(fake)).toStrictEqual([inboxAddress(EMAIL)]);
    expect(clicks).toStrictEqual([ROW]);
  });

  it("names no account when the account has a browser profile of its own", () => {
    const fake = withGmail("https://mail.google.com/chat/u/0/#chat/home");

    openMail(fake.domicile.browser, EMAIL, "a1", "work");

    expect(navigations(fake)).toStrictEqual(["https://mail.google.com/mail/"]);
  });

  it("waits for a window the browser lists later", () => {
    const fake = new FakeDomicileHost();
    const { browser } = fake.domicile;
    const opened: string[] = [];
    const unlisted: MailBrowser = {
      clickMatch: browser.clickMatch,
      on: browser.on,
      openApp: (url) => {
        opened.push(url);
      },
      get windows() {
        return browser.windows;
      },
    };

    openMail(unlisted, EMAIL, undefined);
    fake.openBrowser("https://mail.google.com/mail/u/0/#label/x", {
      appId: gmailAppId(EMAIL),
      isApp: true,
    });

    expect(opened).toStrictEqual([
      inboxAddress(EMAIL),
      "https://mail.google.com/mail/u/0/#inbox",
    ]);
  });

  it("forgets the mail when the window closes before Gmail starts, or once stopped", () => {
    const closed = new FakeDomicileHost();
    const stopped = new FakeDomicileHost();

    openMail(closed.domicile.browser, EMAIL, undefined);
    closed.set({ browserWindows: [] });
    closed.openBrowser("https://mail.google.com/mail/u/0/#label/x", {
      appId: gmailAppId(EMAIL),
      isApp: true,
    });
    openMail(stopped.domicile.browser, EMAIL, undefined)();
    load(stopped, "https://mail.google.com/mail/u/0/#label/x");

    expect(navigations(closed)).toHaveLength(1);
    expect(navigations(stopped)).toHaveLength(1);
  });
});
