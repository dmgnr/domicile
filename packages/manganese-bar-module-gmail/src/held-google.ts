// Test doubles for Google: a desktop whose fetches answer from a table, and
// a store for its tokens.

import type {
  FetchHeader,
  FetchInit,
  FetchResponse,
} from "@domicile-desktop/sdk/desktop/browser";

export const EMAIL = "me@example.com";

export const CLIENT = {
  id: "client.apps.googleusercontent.com",
  secret: "s3cret",
};

export const TOKEN = "https://oauth2.googleapis.com/token";

export const INBOX =
  "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX";

export const UNREAD =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=100";

export const DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

export const SEND_AS =
  "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";

/** The address of message `id`'s sender and subject. */
export const HEADERS = (id: string) =>
  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;

/** Google's answer to a token request: `fields` as JSON. */
export const json = (status: number, fields: object): FetchResponse => ({
  body: JSON.stringify(fields),
  status,
  url: "",
});

type Fetched = {
  url: string;
  method: string;
  headers: readonly FetchHeader[];
  body: string | null;
};

type Answer = FetchResponse | Error;

/**
 * A desktop whose fetches answer from `answers` by address, each address's
 * answers in turn and the last again, rejecting for an `Error`. Records what
 * was asked.
 */
export const answering = (
  answers: Readonly<Record<string, readonly Answer[]>>,
) => {
  const fetched: Fetched[] = [];
  return {
    domicile: {
      browser: {
        fetch: (
          url: string,
          { method = "GET", headers = [], body }: FetchInit = {},
        ): Promise<FetchResponse> => {
          const asked = fetched.filter((one) => one.url === url).length;
          fetched.push({ body: body ?? null, headers, method, url });
          const all = answers[url] ?? [];
          const answer = all[Math.min(asked, all.length - 1)];
          if (answer === undefined) {
            throw new Error(`test: nothing answers ${url}`);
          } else {
            return answer instanceof Error
              ? Promise.reject(answer)
              : Promise.resolve(answer);
          }
        },
      },
    },
    fetched,
  };
};

/** An empty store, as `localStorage` is. */
export const heldStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};
