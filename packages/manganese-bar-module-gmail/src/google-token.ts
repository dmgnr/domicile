import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import type {
  Browser,
  FetchResponse,
} from "@domicile-desktop/sdk/desktop/browser";
import { z } from "zod";

import type { GoogleClient } from "./consent";
import { REDIRECT, SCOPES } from "./consent";
import { jsonText } from "./json-text";

/** Google's OAuth token endpoint. */
const TOKEN = "https://oauth2.googleapis.com/token";

/** What asks Google: the browser, with the user's cookies. */
export type Fetch = { readonly browser: Pick<Browser, "fetch"> };

/** Trades a consent redirect's code for the account's refresh token. */
export const exchangeCode = async (
  domicile: Fetch,
  client: GoogleClient,
  code: string,
): Promise<Result<string, string>> =>
  (
    await askToken(domicile, {
      client_id: client.id,
      client_secret: client.secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    })
  ).andThen((answer) =>
    answer.status === 200
      ? parsed(answer, refreshSchema).map((fields) => fields.refresh_token)
      : Err(refused(answer)),
  );

export enum TokenRefusalKind {
  Revoked,
  Failed,
}

/** Why a refresh token got no access token. */
export const TokenRefusal = {
  /** Anything else, for `reason`. */
  Failed: (reason: string) => ({
    kind: TokenRefusalKind.Failed as const,
    reason,
  }),
  /**
   * Google no longer takes the refresh token, or it was granted without
   * every one of {@link SCOPES}: sign in again.
   */
  Revoked: () => ({ kind: TokenRefusalKind.Revoked as const }),
};

export type TokenRefusal = ReturnType<
  (typeof TokenRefusal)[keyof typeof TokenRefusal]
>;

/** An access token, good for `expiresInMs` from when it was asked for. */
export type Access = { token: string; expiresInMs: number };

/** Trades the account's refresh token for an access token. */
export const refreshAccess = async (
  domicile: Fetch,
  client: GoogleClient,
  refreshToken: string,
): Promise<Result<Access, TokenRefusal>> =>
  (
    await askToken(domicile, {
      client_id: client.id,
      client_secret: client.secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  )
    .mapErr((why): TokenRefusal => TokenRefusal.Failed(why))
    .andThen((answer): Result<Access, TokenRefusal> => {
      if (answer.status === 200) {
        return parsed(answer, accessSchema)
          .mapErr((why): TokenRefusal => TokenRefusal.Failed(why))
          .andThen((fields) =>
            SCOPES.every((scope) => fields.scope.split(" ").includes(scope))
              ? Ok({
                  expiresInMs: fields.expires_in * 1000,
                  token: fields.access_token,
                })
              : Err(TokenRefusal.Revoked()),
          );
      } else {
        return Err(
          errorSchema.safeParse(answer.body).data === "invalid_grant"
            ? TokenRefusal.Revoked()
            : TokenRefusal.Failed(refused(answer)),
        );
      }
    });

const askToken = (
  domicile: Fetch,
  form: Readonly<Record<string, string>>,
): Promise<Result<FetchResponse, string>> =>
  domicile.browser
    .fetch(TOKEN, {
      body: new URLSearchParams(form).toString(),
      headers: [
        { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      ],
      method: "POST",
    })
    .then(
      (answer) => Ok(answer),
      (error: unknown) =>
        Err(`the browser could not ask Google: ${String(error)}`),
    );

const refused = (answer: FetchResponse): string =>
  `Google answered ${answer.status.toString()}: ${answer.body}`;

const parsed = <T extends object>(
  answer: FetchResponse,
  schema: z.ZodType<T>,
): Result<T, string> => {
  const fields = jsonText.pipe(schema).safeParse(answer.body);
  return fields.success ? Ok(fields.data) : Err(z.prettifyError(fields.error));
};

const refreshSchema = z.object({ refresh_token: z.string() });

const accessSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  /** The scopes granted, space-separated. */
  scope: z.string(),
});

/** The OAuth error code a refusal names. */
const errorSchema = jsonText.pipe(
  z.object({ error: z.string() }).transform((fields) => fields.error),
);
