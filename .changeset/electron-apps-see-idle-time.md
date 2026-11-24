---
"domicile": minor
"@domicile-desktop/electron-host": minor
"@domicile-desktop/e2e-harness": patch
---

`domicile idle-time [--json]` prints how many seconds nobody has used the desktop. Electron apps read it for `powerMonitor.getSystemIdleTime` and `getSystemIdleState`, so Slack and the like can mark you away.
