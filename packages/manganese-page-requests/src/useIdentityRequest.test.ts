import { describe, expect, it } from "bun:test";
import type {
  WebViewIdentityAccount,
  WebViewIdentityProvider,
  WebViewIdentityStep,
} from "@domicile-desktop/sdk/webview-element";
import {
  WEBVIEW_IDENTITY_EVENT,
  WEBVIEW_IDENTITY_WITHDRAWN_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { act, renderHook } from "@testing-library/react";

import { useIdentityRequest } from "./useIdentityRequest";

const PROVIDER: WebViewIdentityProvider = {
  addAccount: false,
  icon: "",
  name: "idp.example",
  privacyPolicy: "https://news.example/privacy",
  signedOut: false,
  termsOfService: "",
};

const ACCOUNT: WebViewIdentityAccount = {
  identifier: "alex@idp.example",
  name: "Alex Rivera",
  picture: "",
  provider: 0,
  returning: false,
  shared: ["name", "email"],
};

/**
 * A fake engine step, recording its answers. Built by hand because the test
 * DOM lacks the engine's event type; cancelable because claiming it is
 * `preventDefault()`.
 */
const asks = (
  view: HTMLElement,
  answers: string[],
  step: WebViewIdentityStep = "accounts",
): DomicileIdentityEvent => {
  const event = Object.assign(
    new Event(WEBVIEW_IDENTITY_EVENT, { cancelable: true }),
    {
      accounts: () => [ACCOUNT],
      automatic: false,
      button: true,
      choose: (account: number) => {
        answers.push(`choose ${account}`);
      },
      dismiss: () => {
        answers.push("dismiss");
      },
      error: "",
      errorUrl: "",
      frameSite: "",
      moreDetails: () => {
        answers.push("more details");
      },
      providers: () => [PROVIDER],
      purpose: "sign-in" as const,
      signInToProvider: (provider: number) => {
        answers.push(`sign in to ${provider}`);
      },
      site: "news.example",
      step,
    },
  );
  act(() => {
    view.dispatchEvent(event);
  });
  return event;
};

describe("useIdentityRequest", () => {
  // The engine fails unclaimed steps when dispatch returns.
  it("takes the page's step", () => {
    const view = document.createElement("webview");
    const { result } = renderHook(() => useIdentityRequest(view));

    const event = asks(view, []);

    expect(event.defaultPrevented).toBe(true);
    expect(result.current).toMatchObject({
      accounts: [ACCOUNT],
      button: true,
      providers: [PROVIDER],
      purpose: "sign-in",
      site: "news.example",
      step: "accounts",
    });
  });

  it("chooses once and has no step left", () => {
    const view = document.createElement("webview");
    const answers: string[] = [];
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, answers);

    act(() => {
      result.current?.choose(0);
    });

    expect(answers).toStrictEqual(["choose 0"]);
    expect(result.current).toBeUndefined();
  });

  it("opens the provider's sign-in page", () => {
    const view = document.createElement("webview");
    const answers: string[] = [];
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, answers, "signed-out");

    act(() => {
      result.current?.signInToProvider(0);
    });

    expect(answers).toStrictEqual(["sign in to 0"]);
    expect(result.current).toBeUndefined();
  });

  it("opens an error's details", () => {
    const view = document.createElement("webview");
    const answers: string[] = [];
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, answers, "error");

    act(() => {
      result.current?.moreDetails();
    });

    expect(answers).toStrictEqual(["more details"]);
    expect(result.current).toBeUndefined();
  });

  it("dismisses it", () => {
    const view = document.createElement("webview");
    const answers: string[] = [];
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, answers);

    act(() => {
      result.current?.dismiss();
    });

    expect(answers).toStrictEqual(["dismiss"]);
    expect(result.current).toBeUndefined();
  });

  it("shows the next step in place of the last", () => {
    const view = document.createElement("webview");
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, []);

    asks(view, [], "verifying");

    expect(result.current?.step).toBe("verifying");
  });

  it("drops a step the browser withdrew", () => {
    const view = document.createElement("webview");
    const answers: string[] = [];
    const { result } = renderHook(() => useIdentityRequest(view));
    asks(view, answers);

    act(() => {
      view.dispatchEvent(new Event(WEBVIEW_IDENTITY_WITHDRAWN_EVENT));
    });

    expect(result.current).toBeUndefined();
    expect(answers).toStrictEqual([]);
  });
});
