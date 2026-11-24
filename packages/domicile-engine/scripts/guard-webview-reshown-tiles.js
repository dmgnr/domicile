// The shell for guard-webview-reshown-tiles.sh. It draws one browser window in
// a <webview>, hides its box with `display: none` and shows it again, as
// manganese does when a workspace slides away and back.
//
// - claim: the box comes back as it was
// - control (`?mode=control`): it comes back at half its scale, set while
//   hidden, which no kept tile fits
//
// `?src=` is the page.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded    this module ran
//   GUARD attached        the <webview> reported its page
//   GUARD hiding          the box is hidden
//   GUARD reshowing       the box is shown again; also a trace TimeStamp
//   GUARD done            two seconds later
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
      throw new Error(`guard-webview-reshown-tiles: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-webview-reshown-tiles: no desktop was handed to Shell, so this" +
        " document was not served by the forked engine",
    );
  }

  const parameters = new URLSearchParams(location.search);
  const src = required(parameters, "src");
  const mode = required(parameters, "mode");

  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.inset = "0";
  box.style.transformOrigin = "0 0";
  document.body.append(box);

  const wait = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  // Hides the box long enough for its page to hear it, then shows it again.
  // The trace's TimeStamp marks the moment, so the guard counts only what the
  // page rastered after it.
  const hideAndReshow = async () => {
    say("hiding");
    box.style.display = "none";
    await wait(1500);
    if (mode === "control") {
      box.style.transform = "scale(0.5)";
    }
    console.timeStamp("GUARD reshowing");
    say("reshowing");
    box.style.display = "block";
    await wait(2000);
    say("done");
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
        // After the page's first frames, so its load is not counted.
        setTimeout(() => {
          hideAndReshow().catch((error) => {
            say(`threw ${error}`);
          });
        }, 2000);
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
