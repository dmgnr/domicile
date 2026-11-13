// The shell module guard-webview-sign-in-with.sh loads: one browser window
// under a strip of shell UI, on guard-webview-sign-in-with-server.py's site,
// which signs in with the provider it also serves.
//
// The shell answers each "Sign in with" step the page asks, in order:
//
//   1. the accounts: it chooses the one account, and the page reports the
//      provider's token
//   2. the accounts again: it navigates the page away, which ends the request
//      and withdraws the step
//   3. the accounts on the next page: it dismisses them, and the page reports
//      the rejection
//
// Any other step (verifying, say) it claims and leaves for the next one to
// replace, since its default answer could end the request.
//
// A shell is a module the engine loads into its own document (see
// ShellURLLoaderFactory::ShellDocument), so the guard ships a module, not HTML.

export const HostShell = () => {
  /**
   * Reads a required query parameter. Throws when missing: a default would
   * measure a setup the guard did not ask for.
   */
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-webview-sign-in-with: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const parameters = new URLSearchParams(location.search);
  const src = required(parameters, "src");

  const stripHeight = `${required(parameters, "strip")}px`;
  const strip = document.createElement("div");
  strip.style.position = "absolute";
  strip.style.insetBlockStart = "0";
  strip.style.insetInline = "0";
  strip.style.inlineSize = "100%";
  strip.style.blockSize = stripHeight;
  strip.style.background = "#204060";

  // Sized rather than stretched between insets: see
  // guard-webview-routed-link.js.
  const view = document.createElement("webview");
  view.style.position = "absolute";
  view.style.insetBlockStart = stripHeight;
  view.style.insetInline = "0";
  view.style.inlineSize = "100%";
  view.style.blockSize = `calc(100% - ${stripHeight})`;
  view.style.border = "0";

  let accountsAsked = 0;
  view.addEventListener("domicile-identity", (event) => {
    event.preventDefault();
    const providers = event.providers();
    const accounts = event.accounts();
    console.log(
      [
        "GUARD identity",
        `step=${event.step}`,
        `button=${event.button}`,
        `site=${event.site}`,
        `provider=${providers[0]?.name ?? ""}`,
        `account=${accounts[0]?.name ?? ""}`,
        `shared=${accounts[0]?.shared.join(",") ?? ""}`,
      ].join(" "),
    );
    if (event.step !== "accounts") {
      return;
    }
    accountsAsked += 1;
    if (accountsAsked === 1) {
      event.choose(0);
    } else if (accountsAsked === 2) {
      view.setAttribute("src", src.replace("phase=1", "phase=2"));
    } else {
      console.log("GUARD identity dismissing");
      event.dismiss();
    }
  });
  view.addEventListener("domicile-identity-withdrawn", () => {
    console.log(`GUARD identity-withdrawn after=${accountsAsked}`);
  });

  document.body.style.margin = "0";
  document.body.append(strip);

  // Set `src` after the element is in the document. `src` makes the <webview>
  // ask for a guest, and before insertion there is no frame to attach it to.
  document.body.append(view);
  view.setAttribute("src", src);

  console.log("GUARD shell-loaded");
};
