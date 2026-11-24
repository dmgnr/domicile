---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
---

Electron apps' views (`WebContentsView`) reach the shell. The Electron socket opens a view with `open_window` and `"view": true`, and places a window's views with `set_views`. Each page's size goes back to the app as `resized`. A browser window list includes each view right after the window that holds it, with `parent`, `x`, `y`, `width`, `height` and `isHidden`, so the shell can draw it where its app asks or lay it out its own way.
