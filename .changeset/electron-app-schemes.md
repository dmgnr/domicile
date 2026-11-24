---
"domicile": minor
"@domicile-desktop/electron-host": minor
---

An Electron app's own schemes (`app://` and the like) now reach the engine. When an app registers a scheme the engine doesn't have yet, `electron-host` keeps it in `$XDG_STATE_HOME/domicile/electron-schemes.json` and the app runs on its own Electron this time; from the next engine start, `domicile` registers every kept scheme and the app runs on the engine.
