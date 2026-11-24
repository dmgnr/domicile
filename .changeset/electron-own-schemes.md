---
"domicile": minor
"@domicile-desktop/engine": minor
---

The engine registers Electron apps' own schemes as it starts, from `--domicile-electron-schemes=app:standard,secure;…`, with Electron's names for the privileges (`standard`, `secure`, `bypassCSP`, `corsEnabled` and `supportFetchAPI`). Every child process gets the switch, so a URL parses the same in each. The Electron socket's `ready` names the schemes registered and their privileges. See docs/architecture/ELECTRON-APPS.md.
