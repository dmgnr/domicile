// The shell guard-scrolling-bubble.sh drives. It draws each window in an
// `<app>` at its own size at the page's top left. The window's subsurface is
// part of the window's own frame, so it has no `<app>`.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded                this module ran
//   GUARD drawn app=<id>              an `<app>` for a window is on the page
//
// Everything is inside `HostShell`, which Domicile's document calls once the module
// loads.

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  if (desktop === null || desktop === undefined) {
    throw new Error(
      "guard-scrolling-bubble: no desktop was handed to Shell, so this" +
        " document was not served by the forked engine",
    );
  }

  // Not any color the client draws, so the cast reader cannot find the page.
  document.body.style.background = "#202020";

  const apps = new Map();
  const draw = () => {
    for (const listed of desktop.windows) {
      if (!apps.has(listed.appId)) {
        const app = document.createElement("app");
        app.setAttribute("app-id", listed.appId);
        document.body.append(app);
        apps.set(listed.appId, app);
        say(`drawn app=${listed.appId}`);
      }
      Object.assign(apps.get(listed.appId).style, {
        blockSize: `${listed.height ?? 0}px`,
        inlineSize: `${listed.width ?? 0}px`,
        insetBlockStart: "0",
        insetInlineStart: "0",
        margin: "0",
        position: "fixed",
      });
    }
  };
  desktop.addEventListener("windowschanged", draw);
  draw();

  say("shell-loaded");
};
