---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/electron-host": minor
"@domicile-desktop/component-library": patch
"@domicile-desktop/manganese-bar-module-gmail": patch
---

Electron apps can make their windows fullscreen (`setFullScreen`), and they read and hear what the shell makes them (`isMaximized`, `isFullScreen`, `maximize`, `enter-full-screen` and the rest) instead of a window that always reads as normal. Shells read what an app asks from a window's `wantsMaximized`, `wantsMinimized` and `wantsFullscreen`, and report what they made it with `domicile.browser.setWindowState`.
