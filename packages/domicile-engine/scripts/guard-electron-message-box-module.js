// The shell for guard-electron-message-box.sh. It reads the message box each
// browser window lists, says what it read, and answers the guard's boxes as a
// user would: "Quit?" with Quit and its checkbox checked, "Second?" with
// Cancel, and "Third?" not at all, so the guard can close its window under it.
//
//   GUARD shell-loaded                                  this module ran
//   GUARD box id=… <message> buttons=… default=… cancel=… checkbox=…
//                                                       a window's box
//   GUARD answered id=… response=… checked=…            the shell answered

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const said = new Map();
  const answers = new Map([
    ["Quit?", [1, true]],
    ["Second?", [0, false]],
  ]);

  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      if (window.messageBox === null) {
        said.delete(window.id);
        continue;
      }
      const box = JSON.parse(window.messageBox);
      const line = `box id=${window.id} ${box.message} buttons=${box.buttons.join(",")} default=${box.defaultId} cancel=${box.cancelId} checkbox=${box.checkboxLabel}`;
      if (said.get(window.id) === line) {
        continue;
      }
      said.set(window.id, line);
      say(line);
      const answer = answers.get(box.message);
      if (answer !== undefined) {
        const [response, checked] = answer;
        desktop.answerBrowserWindowMessageBox(window.id, response, checked);
        say(`answered id=${window.id} response=${response} checked=${checked}`);
      }
    }
  });

  say("shell-loaded");
};
