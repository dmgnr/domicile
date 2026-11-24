---
"@domicile-desktop/engine": patch
"domicile": patch
---

A window's new buffer reaches the desktop only once the GPU has made its image. A window that resized and then sat still, such as Blender, no longer stays blank.
