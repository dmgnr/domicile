---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app's sandboxed preload gets the rest of Electron's `electron` module: `webFrame` (the main frame, with `frameToken`, `top`, `insertCSS`, `removeInsertedCSS` and the zoom), `crashReporter`, and `webUtils` and `nativeImage`, whose calls say they don't work yet. Its `process` has `isMainFrame`. A window's `webPreferences.additionalArguments` reach its page's `process.argv`, which the host sends as `open_window`'s `arguments`. Claude's preloads need all of these: without them they set up nothing, and claude.ai showed its web layout.
