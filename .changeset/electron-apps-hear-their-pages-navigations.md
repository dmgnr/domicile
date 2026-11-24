---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

Electron apps hear their pages' navigations, as Electron's `did-start-navigation`, `did-navigate`, `did-fail-load` and the rest, and `will-navigate`, `will-frame-navigate` and `will-redirect` can stop one. A `beforeunload` that asks to stay asks the app's `will-prevent-unload` instead of the shell. `navigationHistory.restore` and `removeEntryAtIndex` work.
