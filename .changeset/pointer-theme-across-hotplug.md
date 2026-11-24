---
"@domicile-desktop/engine": patch
"domicile": patch
---

On a console, the pointer keeps the desk's cursor theme when a monitor at another scale appears, such as after undocking. Until the theme loads at the new size, the nearest size already loaded stands in, instead of Chromium's own cursors. A pointer theme that falls back to Chromium's cursors now says why in the journal.
