---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's `setPermissionRequestHandler` answers its pages' permission requests in place of the shell: the engine sends `permission_request` while a session has a `permission_handler`, and the page gets the app's `permission_answer`. See docs/architecture/ELECTRON-APPS.md.
