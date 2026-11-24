---
"domicile": minor
"@domicile-desktop/engine": minor
---

Windows can draw in 10-bit (`ARGB2101010`, `ABGR2101010`) and half-float (`ABGR16161616F`) formats, over dmabuf and `wl_shm`, and keep their extra precision on the page. Over `wl_shm` they can also draw in `XRGB2101010`, `XBGR2101010` and `XBGR16161616F`. Output stays 8-bit for now.
