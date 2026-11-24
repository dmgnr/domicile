// Shell for guard-webview-history-menu.sh: one view navigated to two pages,
// its history listed, an entry gone to, and an entry opened in a new window.
//
// A module, because the engine writes the shell document and loads one module
// (see ShellURLLoaderFactory::ShellDocument). Loaded on a domicile:// page, the
// only origin WebViewGuestHost is bound for.
//
// ?drive=menu runs the schedule. ?drive=gone is the control: it goes to an id
// no entry has, which must leave the view where it is, so a view that moves on
// any call shows up there.
//
// Logs to the console, which the engine writes to its log:
//
//   GUARD driving mode=…              the module ran, and which run this is
//   GUARD history back=… forward=…    each side's entries, as path|title
//   GUARD first-page path=…           where the view is after going to an entry
//   GUARD new-window url=…            a listed window's address, on each change
//   GUARD first-page-after path=…     where the view is after the new window
//   GUARD done                        the schedule finished
//
// Domicile calls `HostShell` once the module loads.

export const HostShell = (_root, desktop) => {
  /**
   * Reads a required query parameter. No default, so a misconfigured run fails.
   */
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-webview-history-menu: ?${name}= is required`);
    } else {
      return value;
    }
  };

  /**
   * Reads a required millisecond query parameter. Throws rather than return NaN.
   */
  const requiredMilliseconds = (parameters, name) => {
    const value = Number(required(parameters, name));
    if (Number.isFinite(value)) {
      return value;
    } else {
      throw new Error(
        `guard-webview-history-menu: ?${name}= is a number of ms`,
      );
    }
  };

  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  if (desktop === null || desktop === undefined) {
    throw new Error(
      "guard-webview-history-menu: no desktop was handed to Shell, so this" +
        " document is not a shell the engine serves",
    );
  }

  const parameters = new URLSearchParams(location.search);
  const base = required(parameters, "src");
  const mode = required(parameters, "drive");
  if (mode !== "menu" && mode !== "gone") {
    throw new Error(
      `guard-webview-history-menu: ?drive= is "menu" or "gone", got "${mode}"`,
    );
  }
  // Timeout for the first page to attach and navigate.
  const settle = requiredMilliseconds(parameters, "settle");
  // Timeout for each later step, and how long the run watches after a call.
  const step = requiredMilliseconds(parameters, "step");

  const POLL_MS = 50;

  /**
   * A <webview> filling the window. An explicit size: a replaced element with
   * `auto` size takes its intrinsic 300x150.
   */
  const viewFilling = () => {
    const view = document.createElement("webview");
    view.style.position = "absolute";
    view.style.inset = "0";
    view.style.inlineSize = "100%";
    view.style.blockSize = "100%";
    view.style.border = "0";
    return view;
  };

  // A URL's path, or "" for none (`new URL("")` throws).
  const pathIn = (url) => (url === "" ? "" : new URL(url).pathname);

  // Resolves once `ready()` holds, or once `within` ms have passed regardless.
  const until = (ready, within) =>
    new Promise((resolve) => {
      const deadline = Date.now() + within;
      const poll = () => {
        if (ready() || Date.now() >= deadline) {
          resolve();
        } else {
          setTimeout(poll, POLL_MS);
        }
      };
      poll();
    });

  const pause = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  // Each listed window's last reported address. Every listed window is one the
  // call opened: this document's own view is in no list.
  const reported = new Map();
  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      if (reported.get(window.id) !== window.url) {
        say(`new-window url=${window.url}`);
      }
      reported.set(window.id, window.url);
    }
  });

  const view = viewFilling();

  const shows = (path) => () =>
    pathIn(view.url ?? "") === path && !view.loading;

  const navigate = async (path, within) => {
    view.setAttribute("src", `${base}${path}`);
    await until(shows(path), within);
  };

  const listed = (entries) =>
    entries.map((entry) => `${pathIn(entry.url)}|${entry.title}`).join(",");

  // Lists the history and logs it.
  const list = async () => {
    const history = await view.history();
    say(
      `history back=${listed(history.back)} forward=${listed(history.forward)}`,
    );
    return history;
  };

  const run = async () => {
    say(`driving mode=${mode}`);
    // Attach before navigating: `src` requests the guest, which needs a frame.
    document.body.append(view);
    await navigate("/one", settle);
    await navigate("/two", step);
    await until(() => view.canGoBack, step);

    const before = await list();

    if (mode === "gone") {
      // No entry has a negative id: NavigationEntry ids count up from 1.
      view.goToHistoryEntry(-1);
      // A fixed wait, not a poll: the control checks for an absence.
      await pause(step);
      say(`first-page path=${pathIn(view.url ?? "")}`);
    } else {
      view.goToHistoryEntry(before.back[0].id);
      await until(shows("/one"), step);
      say(`first-page path=${pathIn(view.url ?? "")}`);
      await pause(POLL_MS * 4);

      const after = await list();
      view.goToHistoryEntryInNewWindow(after.forward[0].id);
      // A fixed wait: the view staying put is an absence.
      await pause(step);
      say(`first-page-after path=${pathIn(view.url ?? "")}`);
    }
    say("done");
  };

  run().catch((error) => {
    say(`failed ${error}`);
  });
};
