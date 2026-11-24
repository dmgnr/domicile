---
"@domicile-desktop/engine": patch
"domicile": patch
"@domicile-desktop/app-settings": patch
---

Settings shows each extension's own icon, on the Extensions page and on each profile's card, instead of its initial, which stays for an extension without one. A profile card lists its extensions in two columns at most, so their names fit. The engine's extension list names each extension's icon file, which `domicile-app-host` hands to Settings as an image.
