import { describe, expect, it } from "bun:test";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";

import { SCOPES } from "./consent";
import {
  answering,
  CLIENT,
  DRAFTS,
  EMAIL,
  heldStorage,
  json,
  TOKEN,
} from "./held-google";
import { storeToken } from "./stored-token";
import { writeMail } from "./write-mail";

const ALIAS = "me@work.example";
const LINK = "mailto:a@example.com?subject=Hi";

const ACCESS = json(200, {
  access_token: "a",
  expires_in: 3600,
  scope: SCOPES.join(" "),
});

/** A desktop answering from `answers`, recording the windows it opens. */
const desktop = (answers: Parameters<typeof answering>[0]) => {
  const { domicile, fetched } = answering(answers);
  const opened: [string, object | undefined][] = [];
  return {
    domicile: {
      browser: {
        ...domicile.browser,
        openApp: (url: string, options?: object) => {
          opened.push([url, options]);
        },
      },
    },
    fetched,
    opened,
  };
};

const signedIn = () => {
  const storage = heldStorage();
  storeToken(EMAIL, "r", storage);
  return storage;
};

/** A `warn` that keeps what it is told. */
const heldWarn = () => {
  const told: string[] = [];
  return { told, warn: (message: string) => told.push(message) };
};

describe(writeMail, () => {
  it("opens Gmail's new message form from the account's own address, asking nothing", async () => {
    const { domicile, fetched, opened } = desktop({});

    await writeMail(domicile, CLIENT, EMAIL, LINK, EMAIL, "work");

    expect(fetched).toHaveLength(0);
    expect(opened).toStrictEqual([
      [
        "https://mail.google.com/mail/?extsrc=mailto&url=mailto%3Aa%40example.com%3Fsubject%3DHi",
        {
          id: "gmail:me@example.com",
          profile: "work",
          reuse: AppReuse.Navigate,
        },
      ],
    ]);
  });

  it("starts a draft from an alias, then opens it", async () => {
    const { domicile, fetched, opened } = desktop({
      [DRAFTS]: [json(200, { id: "r-1", message: { id: "18c2f0a" } })],
      [TOKEN]: [ACCESS],
    });

    await writeMail(
      domicile,
      CLIENT,
      EMAIL,
      LINK,
      ALIAS,
      undefined,
      signedIn(),
    );

    const drafted = fetched.find(({ url }) => url === DRAFTS);
    const raw = JSON.parse(drafted?.body ?? "{}").message.raw as string;
    expect(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))).toStartWith(
      `From: ${ALIAS}\r\nTo: a@example.com\r\nSubject: Hi\r\n`,
    );
    expect(opened).toStrictEqual([
      [
        "https://mail.google.com/mail/?authuser=me%40example.com#drafts?compose=18c2f0a",
        { id: "gmail:me@example.com", reuse: AppReuse.Navigate },
      ],
    ]);
  });

  it("opens the form from the account's own address, saying why, when Gmail saves no draft", async () => {
    const { domicile, opened } = desktop({
      [DRAFTS]: [json(403, {})],
      [TOKEN]: [ACCESS],
    });
    const { told, warn } = heldWarn();

    await writeMail(
      domicile,
      CLIENT,
      EMAIL,
      LINK,
      ALIAS,
      undefined,
      signedIn(),
      warn,
    );

    expect(told).toStrictEqual([
      `Gmail could not start an email from ${ALIAS}: Gmail answered 403: {}`,
    ]);
    expect(opened.map(([url]) => url)).toStrictEqual([
      "https://mail.google.com/mail/?authuser=me%40example.com&extsrc=mailto&url=mailto%3Aa%40example.com%3Fsubject%3DHi",
    ]);
  });

  it("says the account needs to sign in again when its token lacks a scope", async () => {
    const { domicile } = desktop({
      [TOKEN]: [json(200, { access_token: "a", expires_in: 3600, scope: "" })],
    });
    const { told, warn } = heldWarn();

    await writeMail(
      domicile,
      CLIENT,
      EMAIL,
      LINK,
      ALIAS,
      undefined,
      signedIn(),
      warn,
    );

    expect(told).toStrictEqual([
      `Gmail could not start an email from ${ALIAS}: ${EMAIL} needs to sign in again`,
    ]);
  });

  it("says the account is signed out", async () => {
    const { domicile, fetched } = desktop({});
    const { told, warn } = heldWarn();

    await writeMail(
      domicile,
      CLIENT,
      EMAIL,
      LINK,
      ALIAS,
      undefined,
      heldStorage(),
      warn,
    );

    expect(fetched).toHaveLength(0);
    expect(told).toStrictEqual([
      `Gmail could not start an email from ${ALIAS}: ${EMAIL} is signed out`,
    ]);
  });
});
