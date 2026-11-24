// The shell guard-webview-click-match.sh runs: one browser window, whose
// element clicks a selector's first match in its page once it has loaded.
//
// Logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded               the module ran
//   GUARD bad-selector name=…        what clickMatch("[") threw
//   GUARD clicked matched=…          whether an element matched
//   GUARD never-clicked why=…        the page never answered
//
// The page logs `GUARD guest-mousedown` when it hears the press.
//
// `?selector=` is the selector clicked.

export const HostShell = () => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const parameters = new URLSearchParams(location.search);
  const src = parameters.get("src");
  const selector = parameters.get("selector");
  if (src === null || selector === null) {
    throw new Error(
      "guard-webview-click-match: ?src= and ?selector= are required",
    );
  } else {
    const view = document.createElement("webview");
    view.style.position = "absolute";
    view.style.inset = "0";
    view.style.border = "0";
    document.body.append(view);
    view.setAttribute("src", src);

    const wait = (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });

    // The element has no guest until the page is attached, and about:blank
    // answers before the page commits, so this clicks once the page has
    // loaded.
    const clicked = async (tries, why) => {
      if (tries === 0) {
        say(`never-clicked why=${why}`);
        return undefined;
      } else if (view.loading || view.url !== src) {
        await wait(250);
        return clicked(tries - 1, `url=${view.url} loading=${view.loading}`);
      } else {
        try {
          return await view.clickMatch(selector);
        } catch (error) {
          await wait(250);
          return clicked(tries - 1, error.name);
        }
      }
    };

    const run = async () => {
      try {
        await view.clickMatch("[");
        say("bad-selector name=none");
      } catch (error) {
        say(`bad-selector name=${error.name}`);
      }
      const matched = await clicked(240, "never asked");
      if (matched !== undefined) {
        say(`clicked matched=${matched}`);
      }
    };
    run().catch((error) => {
      say(`threw ${error}`);
    });

    say("shell-loaded");
  }
};
