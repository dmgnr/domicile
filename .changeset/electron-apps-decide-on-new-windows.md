---
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
"domicile": minor
---

An Electron app's `setWindowOpenHandler` decides on its pages' new windows (`window.open`, `target="_blank"`, a middle click) before any opens. A denied window opens nothing, so a link the app hands to `shell.openExternal` opens in the user's browser with their sign-ins, not in the app's storage; an allowed one is a new `BrowserWindow` of the app, and `did-create-window` fires. `electron.profiles`, `domicile open --electron --profile` and the guess that sent noopener links to the browser are gone.
