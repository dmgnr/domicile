import { describe, expect, it } from "bun:test";
import type {
  WebViewIdentityAccount,
  WebViewIdentityProvider,
} from "@domicile-desktop/sdk/webview-element";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityAsk } from "./IdentityAsk";
import type { IdentityRequest } from "./useIdentityRequest";

const PROVIDER: WebViewIdentityProvider = {
  addAccount: false,
  icon: "",
  name: "idp.example",
  privacyPolicy: "https://news.example/privacy",
  signedOut: false,
  termsOfService: "https://news.example/terms",
};

const ALEX: WebViewIdentityAccount = {
  identifier: "alex@idp.example",
  name: "Alex Rivera",
  picture: "",
  provider: 0,
  returning: false,
  shared: ["name", "email", "picture"],
};

const WORK: WebViewIdentityAccount = {
  ...ALEX,
  identifier: "alex@studio.example",
};

/** A step from news.example, signing in with idp.example, recording answers. */
const requestFor = (
  answers: string[],
  overrides: Partial<IdentityRequest> = {},
): IdentityRequest => ({
  accounts: [ALEX],
  button: true,
  choose: (account) => {
    answers.push(`choose ${account}`);
  },
  dismiss: () => {
    answers.push("dismiss");
  },
  errorUrl: "",
  moreDetails: () => {
    answers.push("more details");
  },
  providers: [PROVIDER],
  purpose: "sign-in",
  signInToProvider: (provider) => {
    answers.push(`sign in to ${provider}`);
  },
  site: "news.example",
  step: "accounts",
  ...overrides,
});

const ask = (request: IdentityRequest, opened: string[] = []) =>
  render(
    <IdentityAsk
      onOpenLink={(url) => {
        opened.push(url);
      }}
      request={request}
    />,
  );

const button = (name: string): HTMLElement =>
  screen.getByRole("button", { name });

describe("IdentityAsk", () => {
  describe("the accounts", () => {
    it("asks over the page after the site's own button", () => {
      ask(requestFor([]));

      expect(
        screen.getByRole("alertdialog", {
          name: "Sign in to news.example with idp.example",
        }),
      ).toBeInTheDocument();
    });

    it("titles it by what the site signs in for", () => {
      ask(requestFor([], { purpose: "sign-up" }));
      expect(
        screen.getByRole("alertdialog", {
          name: "Sign up to news.example with idp.example",
        }),
      ).toBeInTheDocument();
    });

    it("leaves the page usable when the site offers it unasked", () => {
      ask(requestFor([], { button: false }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", {
          name: "Sign in to news.example with idp.example",
        }),
      ).toBeInTheDocument();
    });

    it("continues as the one account", async () => {
      const answers: string[] = [];
      ask(requestFor(answers));

      await userEvent.click(button("Continue as Alex"));

      expect(answers).toStrictEqual(["choose 0"]);
    });

    it("continues from the corner card", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { button: false }));

      await userEvent.click(button("Continue as Alex"));

      expect(answers).toStrictEqual(["choose 0"]);
    });

    it("picks one of several accounts", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { accounts: [ALEX, WORK] }));

      await userEvent.click(button("Alex Rivera alex@studio.example"));

      expect(answers).toStrictEqual(["choose 1"]);
    });

    it("says what signing in shares the first time", () => {
      ask(requestFor([]));

      expect(
        screen.getByText(
          /^To continue, idp\.example will share your name, email address and profile picture with this site\./u,
        ),
      ).toBeInTheDocument();
    });

    it("says nothing about sharing for a returning account", () => {
      ask(
        requestFor([], {
          accounts: [{ ...ALEX, returning: true, shared: [] }],
        }),
      );

      expect(screen.queryByText(/will share/u)).not.toBeInTheDocument();
    });

    it("opens the site's privacy policy in a browser window", async () => {
      const opened: string[] = [];
      ask(requestFor([]), opened);

      await userEvent.click(
        screen.getByRole("link", { name: "privacy policy" }),
      );

      expect(opened).toStrictEqual(["https://news.example/privacy"]);
    });

    it("signs in another account where the provider can", async () => {
      const answers: string[] = [];
      ask(
        requestFor(answers, { providers: [{ ...PROVIDER, addAccount: true }] }),
      );

      await userEvent.click(button("Use another account"));

      expect(answers).toStrictEqual(["sign in to 0"]);
    });

    it("cancels", async () => {
      const answers: string[] = [];
      ask(requestFor(answers));

      await userEvent.click(button("Cancel"));

      expect(answers).toStrictEqual(["dismiss"]);
    });

    it("cancels on Escape", async () => {
      const answers: string[] = [];
      ask(requestFor(answers));

      button("Continue as Alex").focus();
      await userEvent.keyboard("{Escape}");

      expect(answers).toStrictEqual(["dismiss"]);
    });

    it("closes the card the site offered unasked", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { button: false }));

      await userEvent.click(button("Close"));

      expect(answers).toStrictEqual(["dismiss"]);
    });
  });

  describe("the other steps", () => {
    it("waits for the accounts", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { accounts: [], step: "loading" }));

      expect(screen.getByRole("status")).toHaveAccessibleName(
        "Finding your accounts…",
      );
      await userEvent.click(button("Cancel"));
      expect(answers).toStrictEqual(["dismiss"]);
    });

    it("offers the provider's sign-in when signed out of it", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { accounts: [], step: "signed-out" }));

      expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
        "You're not signed in to idp.example. Sign in there, then come back to pick your account.",
      );
      await userEvent.click(button("Sign in to idp.example"));
      expect(answers).toStrictEqual(["sign in to 0"]);
    });

    it("shows the account signing in, with nothing to press", () => {
      ask(requestFor([], { button: false, step: "verifying" }));

      expect(
        screen.getByRole("dialog", { name: "Signing you in to news.example" }),
      ).toHaveTextContent("alex@idp.example");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("says the provider refused", async () => {
      const answers: string[] = [];
      ask(requestFor(answers, { accounts: [], step: "error" }));

      expect(
        screen.getByRole("alertdialog", {
          name: "Can't sign in with idp.example",
        }),
      ).toHaveAccessibleDescription(
        "idp.example didn't let news.example sign you in. Try again later, or use the site's own sign-in.",
      );
      expect(
        screen.queryByRole("button", { name: "More details" }),
      ).not.toBeInTheDocument();
      await userEvent.click(button("OK"));
      expect(answers).toStrictEqual(["dismiss"]);
    });

    it("gives OK the keyboard on an error over the page", () => {
      const focused: HTMLElement[] = [];
      render(
        <IdentityAsk
          onOpenLink={() => undefined}
          ref={(element) => {
            if (element !== null) {
              focused.push(element);
            }
          }}
          request={requestFor([], { accounts: [], step: "error" })}
        />,
      );

      expect(focused).toStrictEqual([button("OK")]);
    });

    it("opens the provider's page about the error", async () => {
      const answers: string[] = [];
      ask(
        requestFor(answers, {
          accounts: [],
          errorUrl: "https://idp.example/why",
          step: "error",
        }),
      );

      await userEvent.click(button("More details"));

      expect(answers).toStrictEqual(["more details"]);
    });
  });
});
