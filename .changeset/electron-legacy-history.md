---
"@domicile-desktop/electron-host": patch
---

Electron apps can call `webContents.canGoBack()` and Electron's other older history methods, so Element no longer falls back to its own Electron.
