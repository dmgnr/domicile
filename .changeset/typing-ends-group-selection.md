---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": patch
"domicile": patch
---

Typing in a window ends a group selection (Meta+A) around it. `<app>` and `<webview>` fire `domicile-key-delivered`, which names no key, for each key press their window gets.
