---
"@domicile-desktop/engine": patch
"domicile": patch
"@domicile-desktop/manganese-window-management": patch
---

Opening, closing and settling a browser window no longer rasters its page again every frame, which made these animations janky on heavy pages. A fading window also reuses its page's last drawing instead of redrawing it each frame.
