---
"domicile": minor
"@domicile-desktop/engine": minor
---

The engine takes Electron apps on a new socket, `--domicile-electron-socket`, which the desktop passes and names to apps in `DOMICILE_ELECTRON_SOCK`. An app's `electron-host` says hello and opens app windows in the app's own partition, and hears each window load, change its title and close. See docs/architecture/ELECTRON-APPS.md.
