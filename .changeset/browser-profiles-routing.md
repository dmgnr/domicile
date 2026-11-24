---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
---

Pages open in the profile of their site: the most specific of the config's `browser.sites`, or the default profile. A link, the address bar or back and forward to a site of another profile moves the window's page there in place, keeping its window and its history. Shells get `reopenBrowserWindow(id, profile)` to move a page by hand and `browserProfileFor(url)` to ask where a site goes.
