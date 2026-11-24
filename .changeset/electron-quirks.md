---
"@domicile-desktop/electron-host": patch
---

Apps known to need Node in their pages (Signal, Teams for Linux, Zulip, Joplin) go straight to their own Electron instead of failing on the engine first.
