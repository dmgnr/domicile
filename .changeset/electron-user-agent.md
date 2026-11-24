---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

Electron apps' pages get Electron's user agent (`Name/1.2.3 Chrome/… Electron/…`), and `app.userAgentFallback` and `session.getUserAgent()` give it, so apps such as Claude tell they run in Electron. A page's `dom-ready` comes at its DOMContentLoaded.
