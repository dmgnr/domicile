---
"domicile": patch
"@domicile-desktop/electron-host": patch
---

Electron apps start again on Domicile's engine. Slack died at start because the engine's Electron had no `app.requestSingleInstanceLock`; it has that now, and every other Electron API an app can call is there too. One the engine can't do yet hands the app to its own Electron with a notification saying so, instead of crashing it.

An app whose wrapper script was just written no longer fails to open with "Text file busy" on Domicile's engine.

Element and Claude run on the engine from their first start, since the engine now registers their own schemes before they ask.
