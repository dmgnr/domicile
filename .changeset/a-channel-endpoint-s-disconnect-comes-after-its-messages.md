---
"@domicile-desktop/engine": patch
"domicile": patch
---

A call to a page's widget sent just before the widget closes reaches it before the close, instead of being dropped with "came after the interface disconnected" in the log.
