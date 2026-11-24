---
"@domicile-desktop/sdk": minor
"@domicile-desktop/engine": patch
"domicile": minor
---

A shell can open a scheme's links itself: `domicile.shell.links(["mailto"])` claims them, and `domicile open` (so `xdg-open` and apps' links) and the Email portal hand them to the shell instead of an app.
