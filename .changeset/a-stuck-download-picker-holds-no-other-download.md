---
"@domicile-desktop/engine": patch
"domicile": patch
---

A `<webview>`'s download asks its element where to go before Chrome's one-picker-at-a-time queue, so a picker that is never answered no longer stops every later download in the profile from asking.
