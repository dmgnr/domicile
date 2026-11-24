---
"@domicile-desktop/electron-host": minor
---

Electron apps get `nativeImage`. It reads PNGs and JPEGs from files, buffers, bitmaps and `data:` URLs, and turns PNGs into PNG bytes, `data:` URLs and BGRA bitmaps, resized or cropped. A JPEG is kept as it came: it can't be resized, cropped or turned into a bitmap, and saying so is an error.
