---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
---

Electron apps' menu bars reach the shell. The Electron socket sets a window's menu with `set_menu_bar`, and a browser window list includes it as `menu` (the entries as JSON), with `menuBarVisible` and `menuBarAutoHide`. A shell clicks an entry with `clickBrowserWindowMenu`, and the app hears `menu_clicked` with the entry's id. A `<webview>` also fires `domicile-guest-keyup` for a modifier let go of in its page, so a shell can tell an Alt tap from Alt held for a chord.
