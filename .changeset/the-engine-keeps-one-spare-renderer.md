---
"@domicile-desktop/engine": patch
"domicile": patch
---

The engine keeps one spare renderer process at rest instead of two, so an idle desktop uses about 35 MiB less memory.
