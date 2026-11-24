---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's preload has `ipcRenderer.sendSync` and `ipcRenderer.postMessage` with message ports. `sendSync` reaches the app as `ipc_send_sync`, and the page waits until the app's `ipc_reply`. Ports travel both ways: `ipc_post` carries a message and the ports that went with it, `port_post` and `port_message` carry what goes over a port, and `port_close` and `port_closed` say when one end closed. `page_gone` says a new document replaced a window's page, taking its ports. See docs/architecture/ELECTRON-APPS.md.
