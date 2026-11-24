---
"@domicile-desktop/electron-host": minor
---

An Electron app's `protocol.handle`, `session.fromPartition` and `loadFile` work on Domicile's engine. Each session serves `file:` from the app's mirror until the app handles `file:` itself, a window opens in the session its `webPreferences.partition` or `session` names, and a handler's `Response` streams back to the page. `protocol.registerSchemesAsPrivileged` keeps the app's schemes for the engine's next start.
