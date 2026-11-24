---
"@domicile-desktop/electron-host": minor
---

Electron apps' `Notification`s show on the desktop as the app's, on its notification server. Clicks, buttons, inline replies and closing reach the app as `click`, `action`, `reply` and `close`, and a notification shown again updates in place. The host now also needs the desktop's notification server on the session bus.
