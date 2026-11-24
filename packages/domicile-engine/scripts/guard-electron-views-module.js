// The shell for guard-electron-views.sh. It draws each browser window in a
// full-page <webview window>, and each Electron view where its app asks, over
// its window: the layout docs/architecture/ELECTRON-APPS.md describes for a
// shell that honors the app's.
//
//   GUARD shell-loaded                    this module ran
//   GUARD drawn id=…                      a window or view was drawn
//   GUARD view id=… parent=… x y w h      a view was placed where its app asks

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  document.body.style.margin = "0";
  const drawn = new Map();
  const placed = new Map();

  const draw = (id) => {
    const view = document.createElement("webview");
    view.style.position = "absolute";
    view.style.border = "0";
    view.setAttribute("window", id);
    document.body.append(view);
    drawn.set(id, view);
    say(`drawn id=${id}`);
    return view;
  };

  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      const view = drawn.get(window.id) ?? draw(window.id);
      if (window.parent === null) {
        view.style.inset = "0";
        view.style.inlineSize = "100%";
        view.style.blockSize = "100%";
      } else {
        // Its window fills the page, so the window's top left is the page's.
        view.style.insetInlineStart = `${window.x}px`;
        view.style.insetBlockStart = `${window.y}px`;
        view.style.inlineSize = `${window.width}px`;
        view.style.blockSize = `${window.height}px`;
        view.style.visibility = window.isHidden ? "hidden" : "visible";
        const where = `parent=${window.parent} ${window.x} ${window.y} ${window.width} ${window.height}`;
        if (placed.get(window.id) !== where) {
          placed.set(window.id, where);
          say(`view id=${window.id} ${where}`);
        }
      }
    }
  });

  say("shell-loaded");
};
