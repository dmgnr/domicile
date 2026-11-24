---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's window runs its preload. `open_window` on the Electron socket takes the preload's source, which the engine runs in its own isolated world before the page's scripts, with `require("electron")` giving it `contextBridge.exposeInMainWorld` and `ipcRenderer`. `ipcRenderer.send` and `invoke` reach the app as `ipc_message` and `ipc_invoke`, the app answers with `ipc_reply`, and `ipc_send` reaches the page's listeners. `sendSync` and message ports are not there yet. See docs/architecture/ELECTRON-APPS.md.
