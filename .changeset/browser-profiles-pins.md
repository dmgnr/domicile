---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/manganese": minor
---

The profile menu pins a site to a browser profile, so it opens there from now on. The engine keeps the pins across restarts, under the config's own `browser.sites`: a site the config names shows locked. Shells get `browser.pin(site, profile)`, `browser.siteFor(url)` and each profile's `pinnedSites` and `configSites`.
