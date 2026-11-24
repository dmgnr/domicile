// The shell guard-pdf-after-hiding.sh drives: one browser window showing a
// PDF in a <webview>, in a box the guard hides and shows, as manganese hides
// a tab behind another and brings it back.
//
//   GUARD shell-loaded     this module ran
//   GUARD attached         the <webview> says which page it shows
//
// `globalThis.guardHide()` and `globalThis.guardShow()` hide and show the box
// with `display: none`, as manganese does. The guard calls them over the
// debugging port, between screenshots.
//
// Domicile calls `HostShell` once the module loads.

export const HostShell = (_root, host) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const src = new URLSearchParams(location.search).get("src");
  if (src === null) {
    throw new Error("guard-pdf-after-hiding: ?src= is required");
  }

  document.body.style.margin = "0";
  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.inset = "0";
  document.body.append(box);

  globalThis.guardHide = () => {
    box.style.display = "none";
  };
  globalThis.guardShow = () => {
    box.style.display = "block";
  };

  // A full-size <webview> for window `id`. `window` is set before the element
  // enters the document, when it asks for its page.
  const draw = (id) => {
    const view = document.createElement("webview");
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
    box.append(view);
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
