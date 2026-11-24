---
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
"domicile": minor
---

Electron apps on the engine control their pages: `insertCSS`, `executeJavaScriptInIsolatedWorld`, `reloadIgnoringCache`, `capturePage`, `printToPDF`, device emulation, frame subscription, `copyImageAt`, `copyVideoFrameAt`, `adjustSelection`, caret browsing and the WebRTC IP handling policy. Windows have parents, modals and `setEnabled`, and `getProcessId`, `isWaitingForResponse` and the frame lookups (`webContents.fromFrame`, `webFrameMain.fromId`, `fromFrameToken`, `focusedFrame`) answer from the page.
