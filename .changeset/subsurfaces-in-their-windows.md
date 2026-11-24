---
"@domicile-desktop/engine": minor
"domicile": minor
---

A window's subsurfaces are drawn inside the window itself, as other compositors draw them. Firefox and Tor Browser windows, which draw everything into a subsurface, now move, scale and fade with their window on workspace switches and other animations, and sit under the shell's overlays. Chromium's extension popups do too. Pointer and touch reach the subsurface under them.
