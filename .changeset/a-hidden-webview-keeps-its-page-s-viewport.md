---
"@domicile-desktop/engine": patch
"domicile": patch
---

A `<webview>` hidden with `display: none` keeps its page's compositor viewport, so the tiles it kept are still there when it is shown again. Switching to a workspace with a browser window no longer rasters its whole page in the middle of the slide.
