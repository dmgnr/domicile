---
"@domicile-desktop/electron-host": patch
---

electron-host's coverage checks hold every Electron event too: each one it never fires is filed in `events.json` with why.
