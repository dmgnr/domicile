// The shell for guard-webview-scale-animation.sh. It draws one browser window
// in a <webview>, then scales the window's box, as manganese does when a
// window opens, closes or settles.
//
// - claim: a CSS animation shrinks the box to half its size
// - control (`?mode=control`): the same shrink in steps, each a static
//   `transform` set a frame apart, with no animation running
//
// Either way a requestAnimationFrame loop runs while it scales, so the shell
// runs a main frame every frame, as manganese does while a window closes. A
// main frame is where a <webview>'s page takes a new raster scale.
//
// `?steps=` is the control's step count. `?src=` is the page.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded    this module ran
//   GUARD page-shown      the <webview> reported its page
//   GUARD scaling         the shrink started
//   GUARD done            it ended
//   GUARD threw <error>   it threw
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
      throw new Error(`guard-webview-scale-animation: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const host = desktop;
  if (host === null || host === undefined) {
    throw new Error(
      "guard-webview-scale-animation: no desktop was handed to Shell, so this" +
        " document was not served by the forked engine",
    );
  }

  const parameters = new URLSearchParams(location.search);
  const src = required(parameters, "src");
  const mode = required(parameters, "mode");
  const steps = Number(required(parameters, "steps"));

  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.inset = "0";
  document.body.append(box);

  const nextFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });

  // A main frame every frame until `until` settles.
  const runMainFrames = async (until) => {
    let running = true;
    until.then(
      () => {
        running = false;
      },
      () => {
        running = false;
      },
    );
    while (running) {
      await nextFrame();
    }
  };

  const animate = () =>
    box.animate([{ transform: "scale(1)" }, { transform: "scale(0.5)" }], {
      duration: 1000,
    }).finished;

  const step = async () => {
    for (let index = 1; index <= steps; index += 1) {
      box.style.transform = `scale(${1 - (0.5 * index) / steps})`;
      await nextFrame();
      await nextFrame();
    }
    box.style.transform = "";
  };

  const scale = async () => {
    say("scaling");
    const scaled = mode === "control" ? step() : animate();
    await Promise.all([scaled, runMainFrames(scaled)]);
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
    let shown = false;
    view.addEventListener("domicile-page-change", () => {
      if (!shown) {
        shown = true;
        say("page-shown");
        // After the page's first frames, so its load is not counted as the
        // scale's.
        setTimeout(() => {
          scale().catch((error) => {
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
