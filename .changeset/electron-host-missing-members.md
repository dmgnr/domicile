---
"@domicile-desktop/electron-host": patch
---

Electron apps can trash files, ring the bell, intercept and serve their protocols from directories, use the async `safeStorage` calls, Electron 44's `ClipboardItem` clipboard and `clipboard.selection`, `session.fromPath`, `nativeImage.addRepresentation`, `TouchBar`, and more of `MenuItem`, `Notification`, `BrowserWindow`, `WebContents` and `WebContentsView`, which handed the app back to its own Electron or read as `undefined` before.
