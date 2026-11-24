// The shell for guard-electron-window-state.sh. It reads what each browser
// window's app asks it to be, says what it read, and grants it: it reports
// the window as just that, on every listing, as a shell that reports its
// state each time it lays windows out would.
//
//   GUARD shell-loaded                               this module ran
//   GUARD wants id=… <maximized minimized fullscreen | normal>
//                                                    what a window's app asks

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const said = new Map();

  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      const wants = [
        window.wantsMaximized ? "maximized" : "",
        window.wantsMinimized ? "minimized" : "",
        window.wantsFullscreen ? "fullscreen" : "",
      ]
        .filter((state) => state !== "")
        .join(" ");
      const line = `wants id=${window.id} ${wants === "" ? "normal" : wants}`;
      if (said.get(window.id) !== line) {
        said.set(window.id, line);
        say(line);
      }
      desktop.setBrowserWindowState(
        window.id,
        window.wantsMaximized,
        window.wantsMinimized,
        window.wantsFullscreen,
      );
    }
  });

  say("shell-loaded");
};
