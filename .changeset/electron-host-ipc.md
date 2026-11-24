---
"@domicile-desktop/electron-host": minor
---

An Electron app's windows run their preloads and talk to its main process. `webPreferences.preload` is sent to the engine with the window, `ipcMain.on`, `handle` and `handleOnce` answer the pages' `ipcRenderer`, and `webContents.send` reaches them. A window that asks for Node.js in its page (`nodeIntegration`, or `contextIsolation: false`) fails loudly, since the engine doesn't give a page Node.js.
