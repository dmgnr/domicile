---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
---

Electron apps on the engine get `webContents.executeJavaScript` and `webContents.mainFrame`, a `WebFrameMain` for the page's one frame. Claude Desktop calls both as it starts, and ran on its own Electron for want of them.
