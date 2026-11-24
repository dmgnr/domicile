---
"@domicile-desktop/engine": patch
"domicile": patch
---

The engine shuts down cleanly when the desktop ends. A second SIGTERM, which a session end always sends, no longer kills it part way through saving its profile (patch 0259), and the launcher signals the browser alone and waits up to 15 s for it instead of 3 s. Before, every start counted the last session as a crash.
