---
"@domicile-desktop/engine": patch
"domicile": patch
---

Extensions the config installs from the Web Store stay on across restarts. The engine grants their permissions, which Chrome otherwise found missing at each start and switched them off for. Switching an extension on grants its permissions too, and an extension the config names but never recorded, such as after a crash, uninstalls when the config drops it.
