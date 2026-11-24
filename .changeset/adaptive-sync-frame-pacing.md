---
"domicile": patch
"@domicile-desktop/engine": patch
---

Animations no longer stutter on a monitor running adaptive sync. The engine used to treat each page flip on such a monitor as a vsync and push the next frame back by the time the last one took to draw.
