import { describe, expect, it } from "bun:test";
import { Err, None, Ok, Some } from "@cprussin/option-result";

import { consentAddress, REDIRECT, redirectCode } from "./consent";

const CLIENT = { id: "client.apps.googleusercontent.com", secret: "s3cret" };

describe("consentAddress", () => {
  it("asks for offline access to labels, headers, settings and drafts, for the account", () => {
    const asked = new URL(consentAddress(CLIENT, "me@example.com", "st4te"));

    expect(asked.origin + asked.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(asked.searchParams)).toStrictEqual({
      access_type: "offline",
      client_id: "client.apps.googleusercontent.com",
      login_hint: "me@example.com",
      prompt: "consent",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.compose",
      state: "st4te",
    });
  });
});

describe("redirectCode", () => {
  it("is the code of a redirect with the state", () => {
    expect(
      redirectCode(`${REDIRECT}?state=st4te&code=c0de`, "st4te"),
    ).toStrictEqual(Some(Ok("c0de")));
  });

  it("is the error of a redirect Google refused", () => {
    expect(
      redirectCode(`${REDIRECT}?state=st4te&error=access_denied`, "st4te"),
    ).toStrictEqual(Some(Err("access_denied")));
  });

  it("is nothing for another sign-in's redirect", () => {
    expect(
      redirectCode(`${REDIRECT}?state=other&code=c0de`, "st4te"),
    ).toStrictEqual(None());
  });

  it("is nothing for another address", () => {
    expect(
      redirectCode(
        "https://accounts.google.com/?state=st4te&code=c0de",
        "st4te",
      ),
    ).toStrictEqual(None());
  });

  it("is nothing for a window that has shown nothing", () => {
    expect(redirectCode("", "st4te")).toStrictEqual(None());
  });
});
