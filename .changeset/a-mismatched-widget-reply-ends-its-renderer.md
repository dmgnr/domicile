---
"@domicile-desktop/engine": patch
"domicile": patch
---

A page whose renderer answers the browser with a reply to the wrong request crashes and offers a reload, instead of hanging. The engine logs each message mojo refuses, and why.
