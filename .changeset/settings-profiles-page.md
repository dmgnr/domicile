---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/app-settings": minor
---

Settings has a Profiles page: a card per browser profile with its color, whether it is private and its extension switches, and one list of the sites that open outside the default profile. Profiles, colors, Private and the default change in the config; extension switches and sites added here are saved by the desktop, under the config's. Adding a site that is already listed points at its row. The engine's command socket answers `browser_profiles` and `pin_browser_site`, and `set_extension_enabled` takes a `profile`.
