---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
---

Each browser profile in the config is a Chrome profile of its own, with its own sign-ins, site data and extensions; a private profile keeps nothing past its last page. Shells get `domicile.browserProfiles`, each browser window's `profile`, `openBrowserWindow(url, partition, profile)` and `<webview profile>`. Private pages now open in the default private profile. Extensions stay out of it unless its `extensions` names them, rather than through `extensions.settings.<id>.private`.
