---
"@domicile-desktop/electron-host": minor
---

`electron-host` connects to the engine's Electron socket (`DOMICILE_ELECTRON_SOCK`) as the app, named by its `desktopName`, and its `BrowserWindow` opens, loads, focuses and closes app windows there. A window takes its page's title, is ready to show once its page loads, and the app quits with its last window unless it listens for `window-all-closed`.
