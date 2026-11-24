---
"@domicile-desktop/electron-host": minor
---

An Electron app's `session.webRequest` listeners work on Domicile's engine. `onBeforeRequest` may cancel or redirect a page's request, `onBeforeSendHeaders` may replace its headers, `onHeadersReceived` may cancel it or replace the response's headers and status line, and the other events hear how each request went. Filters take Chromium's URL patterns and resource types, and a listener's answer keeps only what its event may change, as in Electron.
