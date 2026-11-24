---
"@domicile-desktop/electron-host": minor
---

A `Session` has `setPermissionRequestHandler`: while it has a handler, the engine asks it about the session's pages' permission requests, and the page gets its answer. `setPermissionCheckHandler` is taken but not consulted yet, and says so once on stderr.
