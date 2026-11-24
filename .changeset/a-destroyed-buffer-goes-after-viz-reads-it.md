---
"@domicile-desktop/engine": patch
"domicile": patch
---

A window's buffer its app destroys is dropped only once the GPU has finished reading it. A window that resized and then sat still, such as GIMP or LibreOffice beside a browser window, no longer stays blank white.
