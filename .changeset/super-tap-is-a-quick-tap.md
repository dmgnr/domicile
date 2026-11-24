---
"@domicile-desktop/engine": patch
"@domicile-desktop/sdk": minor
"domicile": patch
---

Holding Super for a moment and letting it go no longer opens the overview: only a quick tap, up to 300 ms, does. Shells can set another limit with `keyboard.grab("Meta", { longestTap })`.
