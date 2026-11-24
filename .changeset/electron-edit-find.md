---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

Electron apps can edit and search their pages. `webContents.undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `delete`, `selectAll`, `unselect`, `centerSelection`, `replace` and `replaceMisspelling` now work, and so do the Edit menu's roles, which used to fail when clicked. `webContents.findInPage` searches the page and answers with `found-in-page`, as in Electron, and `stopFindInPage` ends the search.
