---
"@domicile-desktop/engine": patch
"domicile": patch
---

The engine logs an error when a page goes 2 seconds without drawing at its new size after a resize, which leaves it frozen at the old size.
