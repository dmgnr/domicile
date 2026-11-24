---
"domicile": minor
"@domicile-desktop/electron-host": minor
---

`domicile open --electron <entry|path> [-- <command>...]` runs an installed Electron app on the desktop's engine instead of the Electron it ships. It follows the app's desktop entry, through the wrapper scripts packages put around Electron, to the app's `app.asar`, and runs it with `electron-host`, which now ships with Domicile. An app whose page needs Node runs on its own Electron instead, with a notification saying so.
