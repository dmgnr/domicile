---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's sessions take `session_call`s: `cookies.get`, `set`, `remove` and `flushStore`, `clearStorageData`, `clearCache` and `setUserAgent`, each answered by a `session_result`. They act on the session's own partition, and a session's user agent reaches its windows' pages. See docs/architecture/ELECTRON-APPS.md.
