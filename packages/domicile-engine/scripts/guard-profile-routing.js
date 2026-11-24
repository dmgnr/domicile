// The shell for guard-profile-routing.sh. It opens one browser window at
// `?from=`, draws it in a <webview window>, and once the page shows, takes it
// to `?to=` as the address bar does, by setting the element's `src`.
//
// - `?settle=` is the ms between the first page showing and the navigation,
//   and between the navigation and saying settled.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded     this module ran
//   GUARD attached         the <webview> reported its first page
//   GUARD navigated        the shell set `src` to `?to=`
//   GUARD profile=ID       the window's profile, as the list says, on every
//                          change of it
//   GUARD settled          `?settle=` ms after navigating
//
// The page logs where it is and its visibility itself; see
// guard-profile-routing-server.py.
//
// Everything is inside `HostShell`, which Domicile's document calls once the
// module loads.

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  /**
   * Reads a required query parameter. A default would make a misinvoked guard
   * measure the wrong thing.
   */
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-profile-routing: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-profile-routing: no desktop was handed to Shell, so this " +
        "document was not served by the forked engine",
    );
  }

  const parameters = new URLSearchParams(location.search);
  const from = required(parameters, "from");
  const to = required(parameters, "to");
  const settle = Number(required(parameters, "settle"));

  document.body.style.margin = "0";

  // A full-size <webview> for window `id`. `window` is set before the element
  // enters the document, when it asks for its page.
  const draw = (id) => {
    const view = document.createElement("webview");
    view.style.position = "absolute";
    view.style.inset = "0";
    view.style.inlineSize = "100%";
    view.style.blockSize = "100%";
    view.style.border = "0";
    view.setAttribute("window", id);
    // The first report is the window's first page showing. The browser logs
    // each attach, which is how the guard counts the replacement's.
    let navigated = false;
    view.addEventListener("domicile-page-change", () => {
      if (!navigated) {
        navigated = true;
        say("attached");
        setTimeout(() => {
          view.src = to;
          say("navigated");
          setTimeout(() => say("settled"), settle);
        }, settle);
      }
    });
    document.body.append(view);
    return view;
  };

  // The first list is empty, so this opens the window; the next one holds it.
  let listed = false;
  let drawn = false;
  let profile = null;
  host.addEventListener("browserwindowschanged", () => {
    const windows = host.browserWindows ?? [];
    if (!listed) {
      listed = true;
      if (windows.length === 0) {
        host.openBrowserWindow(from);
      }
    }
    if (windows.length > 0) {
      if (!drawn) {
        drawn = true;
        draw(windows[0].id);
      }
      if (windows[0].profile !== profile) {
        profile = windows[0].profile;
        say(`profile=${profile}`);
      }
    }
  });

  say("shell-loaded");
};
