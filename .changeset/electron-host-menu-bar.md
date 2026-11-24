---
"@domicile-desktop/electron-host": minor
---

Electron apps' menus reach the engine as each window's menu bar: `Menu.setApplicationMenu`, `win.setMenu`, `removeMenu`, `autoHideMenuBar`, `setAutoHideMenuBar` and `setMenuBarVisibility`. A click on the bar runs the entry for the window it was clicked in.
