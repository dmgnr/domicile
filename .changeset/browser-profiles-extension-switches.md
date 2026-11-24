---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/manganese": minor
---

The profile menu switches the page's profile's extensions on and off. Every profile now has every extension the config names, switched on or off in it, so one switched off keeps its data. A profile whose config names its `extensions` has those switches locked to the config; any other starts each extension on (off in a private profile) and leaves it to the user. Shells get `browser.setExtensionEnabled(profile, id, enabled)` and each profile's `extensions`, `enabledExtensions` and `lockedExtensions`.
