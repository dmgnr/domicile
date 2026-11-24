---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese": minor
---

Electron apps on the engine behave more like their own Electron:

- Closing a window asks the app first, so an app that closes to its tray, as Slack and Element do, keeps running there instead of quitting.
- `win.hide()`, `win.show()` and `show: false` hide and show a window, its page still running. The engine lists a hidden window with `isHidden`, and Manganese keeps it off every workspace until its app shows it.
- A window's own title (`setTitle`, or `page-title-updated` prevented) is the one the desktop shows, so Claude Desktop reads "Claude", not "index.html".
- `ipcRenderer` is an EventEmitter, so `ipcRenderer.emit` reaches the preload's own listeners. Element's preload calls it as it starts, and showed "Unable to load config file" without it.
- Manganese draws an app window with its app's icon, in its title bar and in the screenshot and screen cast pickers, instead of its page's.
- A window has the properties Electron gives for what its methods set: `autoHideMenuBar`, `menuBarVisible`, `fullScreen`, `resizable` and the rest, and its page `audioMuted`, `backgroundThrottling` and `userAgent`. Element reads `autoHideMenuBar` once its page loads.
