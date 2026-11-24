---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": patch
---

CSS `zoom` on an `<app>` zooms a native window's content and keeps it sharp: the client draws at its display's scale times the zoom, at a logical size that much smaller, so its buffer still fills the box. Popups share their window's zoom.
