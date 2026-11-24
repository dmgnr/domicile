// The shell guard-pdf-zoom.sh drives: one browser window showing a PDF in a
// <webview>, zoomed as manganese zooms one on Ctrl+Plus.
//
//   GUARD shell-loaded     this module ran
//   GUARD attached         the <webview> says which page it shows
//
// `globalThis.guardZoom(factor)` calls the <webview>'s setZoom. The guard
// calls it over the debugging port once the viewer has started.
//
// Domicile calls `HostShell` once the module loads.

export const HostShell = (_root, host) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const src = new URLSearchParams(location.search).get("src");
  if (src === null) {
    throw new Error("guard-pdf-zoom: ?src= is required");
  }

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
    let attached = false;
    view.addEventListener("domicile-page-change", () => {
      if (!attached) {
        attached = true;
        say("attached");
      }
    });
    globalThis.guardZoom = (factor) => {
      view.setZoom(factor);
    };
    document.body.append(view);
  };

  // The first list is empty, so this opens the window; the next one holds it.
  let listed = false;
  let drawn = false;
  host.addEventListener("browserwindowschanged", () => {
    const windows = host.browserWindows ?? [];
    if (!listed) {
      listed = true;
      if (windows.length === 0) {
        host.openBrowserWindow(src);
      }
    }
    if (windows.length > 0 && !drawn) {
      drawn = true;
      draw(windows[0].id);
    }
  });

  say("shell-loaded");
};
