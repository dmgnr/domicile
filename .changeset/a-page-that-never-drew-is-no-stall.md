---
"@domicile-desktop/engine": patch
"domicile": patch
---

A page that has never drawn, such as a new page before its first navigation or an empty cross-site frame, no longer logs as a stalled page at ERROR. A page that drew and then stops still does.
