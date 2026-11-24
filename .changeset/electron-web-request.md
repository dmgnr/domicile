---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's `session.webRequest` listeners see its windows' network requests. `web_request_listen` names a session's events; each request then meets them as `web_request` lines, and `onBeforeRequest`, `onBeforeSendHeaders` and `onHeadersReceived` wait for `web_request_answer`, which may cancel, redirect, or replace the request's or the response's headers. See docs/architecture/ELECTRON-APPS.md.
