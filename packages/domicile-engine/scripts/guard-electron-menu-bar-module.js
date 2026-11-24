// The shell for guard-electron-menu-bar.sh. It reads each browser window's
// menu bar and popup menu from the list, says what it read, clicks the entry
// the guard's app named "Quit" once, as a user clicking it in the bar would,
// and chooses "Settings" from a popup menu that holds it.
//
//   GUARD shell-loaded                          this module ran
//   GUARD menu id=… visible=… auto=… <labels>   a window's menu, by its labels
//   GUARD menu id=… none visible=… auto=…       a window with no menu
//   GUARD clicked id=… command=…                the shell clicked an entry
//   GUARD popup id=… at=x,y <labels>            a window's popup menu
//   GUARD popup id=… none                       a window with no popup menu
//   GUARD chose id=… command=…                  the shell chose from a popup

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const said = new Map();
  const saidPopup = new Map();
  let clicked = false;

  /** Each entry's label, its submenu's after a ">", in order. */
  const labels = (entries) =>
    entries
      .map((entry) =>
        entry.submenu === undefined
          ? entry.label
          : `${entry.label}>${labels(entry.submenu)}`,
      )
      .join(",");

  const find = (entries, label) => {
    for (const entry of entries) {
      if (entry.label === label) {
        return entry;
      }
      const inside = find(entry.submenu ?? [], label);
      if (inside !== undefined) {
        return inside;
      }
    }
    return undefined;
  };

  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      const flags = `visible=${window.menuBarVisible} auto=${window.menuBarAutoHide}`;
      const menu = window.menu === null ? null : JSON.parse(window.menu);
      const line =
        menu === null
          ? `menu id=${window.id} none ${flags}`
          : `menu id=${window.id} ${flags} ${labels(menu)}`;
      if (said.get(window.id) !== line) {
        said.set(window.id, line);
        say(line);
      }
      const quit = menu === null ? undefined : find(menu, "&Quit");
      if (quit !== undefined && !clicked) {
        clicked = true;
        desktop.clickBrowserWindowMenu(window.id, quit.id);
        say(`clicked id=${window.id} command=${quit.id}`);
      }
      const popup =
        window.popupMenu === null ? null : JSON.parse(window.popupMenu);
      const popupLine =
        popup === null
          ? `popup id=${window.id} none`
          : `popup id=${window.id} at=${popup.x},${popup.y} ${labels(popup.menu)}`;
      if (saidPopup.get(window.id) !== popupLine) {
        saidPopup.set(window.id, popupLine);
        say(popupLine);
        const settings =
          popup === null ? undefined : find(popup.menu, "&Settings");
        if (settings !== undefined) {
          desktop.answerBrowserWindowPopupMenu(window.id, settings.id);
          say(`chose id=${window.id} command=${settings.id}`);
        }
      }
    }
  });

  say("shell-loaded");
};
