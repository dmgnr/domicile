---
"@domicile-desktop/electron-host": minor
---

An Electron app's pages can `sendSync` and share message ports with it. A page's `sendSync` gets the first `returnValue` an `ipcMain.on` listener sets, and fails when nothing listens. `MessageChannelMain` and `MessagePortMain` work in the main process, `webContents.postMessage` sends ports to a page, and a page's `postMessage` reaches `ipcMain` listeners with its ports in `event.ports`. A port shared with a page closes when its page goes.
