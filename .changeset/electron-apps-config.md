---
"domicile": minor
"@domicile-desktop/sdk": minor
---

The desk config's `electron.apps` lists desktop file ids of installed Electron apps to run on the desktop's engine. The compositor writes a copy of each entry that runs it with `domicile open --electron`, first on the desk's data directories, so the launcher, links such as `slack://` and notification presses all start it on the engine, whatever the shell.
