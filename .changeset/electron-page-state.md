---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app hears its pages' state from the engine: their history, whether they're loading, which has the keyboard focus, their renderer's pid and whether it crashed. `webContents.navigationHistory` (and `canGoBack`, `goBack` and the rest) now walk the page's real history, `BrowserWindow.getFocusedWindow` and `isFocused` follow the page's focus, and `isLoading`, `isCrashed` and `getOSProcessId` answer truly, with Electron's `did-start-loading`, `did-stop-loading`, `focus`, `blur` and `render-process-gone` events.
