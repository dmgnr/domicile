---
"domicile": patch
"@domicile-desktop/electron-host": patch
---

Electron apps log under their entry's name instead of `domicile`, and `electron-host` gives its own lines their priority: an Electron API Domicile lacks is a warning, one Electron lacks on Linux is a debug line. `domicile` run by a binding logs as `domicile-cli`, and the screen recorder's encoder is a debug line instead of an error.
