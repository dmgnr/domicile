---
"@domicile-desktop/electron-host": minor
---

Give Electron apps `utilityProcess.fork`: the module runs in a child process of the same runtime, with `process.parentPort`, and `MessageChannelMain` ports sent to it carry messages both ways.
