import { describe, expect, it } from "bun:test";
import { Err, Ok } from "@cprussin/option-result";

import { REDIRECT, SCOPES } from "./consent";
import { exchangeCode, refreshAccess, TokenRefusal } from "./google-token";
import { answering, CLIENT, json, TOKEN } from "./held-google";

describe("exchangeCode", () => {
  it("posts the code for a refresh token", async () => {
    const { domicile, fetched } = answering({
      [TOKEN]: [json(200, { access_token: "a", refresh_token: "r" })],
    });

    expect(await exchangeCode(domicile, CLIENT, "c0de")).toStrictEqual(Ok("r"));
    expect(fetched).toStrictEqual([
      {
        body: new URLSearchParams({
          client_id: CLIENT.id,
          client_secret: CLIENT.secret,
          code: "c0de",
          grant_type: "authorization_code",
          redirect_uri: REDIRECT,
        }).toString(),
        headers: [
          {
            name: "Content-Type",
            value: "application/x-www-form-urlencoded",
          },
        ],
        method: "POST",
        url: TOKEN,
      },
    ]);
  });

  it("fails with Google's answer when it refuses", async () => {
    const { domicile } = answering({
      [TOKEN]: [json(400, { error: "invalid_grant" })],
    });

    expect(await exchangeCode(domicile, CLIENT, "c0de")).toStrictEqual(
      Err('Google answered 400: {"error":"invalid_grant"}'),
    );
  });
});

describe("refreshAccess", () => {
  it("posts the refresh token for an access token", async () => {
    const { domicile, fetched } = answering({
      [TOKEN]: [
        json(200, {
          access_token: "a",
          expires_in: 3599,
          scope: SCOPES.join(" "),
        }),
      ],
    });

    expect(await refreshAccess(domicile, CLIENT, "r")).toStrictEqual(
      Ok({ expiresInMs: 3_599_000, token: "a" }),
    );
    expect(fetched.map((one) => one.body)).toStrictEqual([
      new URLSearchParams({
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
        grant_type: "refresh_token",
        refresh_token: "r",
      }).toString(),
    ]);
  });

  it("is revoked when Google no longer takes the refresh token", async () => {
    const { domicile } = answering({
      [TOKEN]: [json(400, { error: "invalid_grant" })],
    });

    expect(await refreshAccess(domicile, CLIENT, "r")).toStrictEqual(
      Err(TokenRefusal.Revoked()),
    );
  });

  it("is revoked when the refresh token cannot read message headers", async () => {
    const { domicile } = answering({
      [TOKEN]: [
        json(200, {
          access_token: "a",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/gmail.labels",
        }),
      ],
    });

    expect(await refreshAccess(domicile, CLIENT, "r")).toStrictEqual(
      Err(TokenRefusal.Revoked()),
    );
  });

  it("fails with Google's answer for any other refusal", async () => {
    const { domicile } = answering({
      [TOKEN]: [json(401, { error: "invalid_client" })],
    });

    expect(await refreshAccess(domicile, CLIENT, "r")).toStrictEqual(
      Err(
        TokenRefusal.Failed('Google answered 401: {"error":"invalid_client"}'),
      ),
    );
  });

  it("fails when the browser cannot ask", async () => {
    const { domicile } = answering({ [TOKEN]: [new Error("offline")] });

    expect(await refreshAccess(domicile, CLIENT, "r")).toStrictEqual(
      Err(
        TokenRefusal.Failed("the browser could not ask Google: Error: offline"),
      ),
    );
  });
});
