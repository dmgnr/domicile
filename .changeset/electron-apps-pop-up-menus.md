---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/electron-host": minor
"@domicile-desktop/component-library": patch
"@domicile-desktop/manganese-bar-module-gmail": patch
---

Electron apps can pop up menus (`Menu.popup`), as Claude's menu button does: the shell draws the app's menu where the button was pressed, with the same look as the app's menu bar, and the entry chosen runs in the app. Shells read a window's popup menu from `popupMenu` (`appPopupMenu` in `@domicile-desktop/sdk/app-menu`) and answer it with `domicile.browser.answerPopupMenu`.
