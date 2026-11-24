// The shell module guard-notification-site-icon.sh loads.
//
// `?site=<origin>&favicon=<red|none>&times=<n>` opens an app window at
// `<site>/notify`, a page that notifies `n` times, with a red favicon or
// none, and draws every browser window the desk lists in a
// `<webview window>`.
//
// It must be a domicile:// document: the browser binds WebViewGuestHost only
// for the shell's origin.
//
// The engine's document calls `HostShell` once the module loads.

export const HostShell = (_root, desktop) => {
  const query = new URLSearchParams(location.search);

  // What was drawn, so each window is drawn once.
  const drawn = new Set();
  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      if (!drawn.has(window.id)) {
        drawn.add(window.id);
        // An explicit size: a replaced element with `auto` size takes its
        // intrinsic 300x150. `window` is set before attaching, since the
        // element reads it once, on asking for a guest.
        const view = document.createElement("webview");
        view.style.inlineSize = "320px";
        view.style.blockSize = "200px";
        view.setAttribute("window", window.id);
        document.body.append(view);
      }
    }
  });

  const page = new URL("/notify", query.get("site"));
  page.searchParams.set("summary", "from-a-site");
  page.searchParams.set("favicon", query.get("favicon"));
  page.searchParams.set("times", query.get("times"));
  desktop.openAppWindow(page.href, "guard-app", "new");
};
