---
"@domicile-desktop/engine": patch
"domicile": patch
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/manganese": minor
---

Electron apps' views show in their windows. The SDK lists them in `domicile.browser.views`, apart from `domicile.browser.windows`, so window lists, task switchers and tiling never treat a view as a window. Manganese draws each view over its window's page where its app asks, hides it while the app hides it, treats a click in it as a click in the window, and runs the app's menu keys pressed in it.
