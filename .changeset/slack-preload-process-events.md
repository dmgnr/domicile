---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

Slack on the engine signs in again: a sandboxed Electron preload's `process` is an EventEmitter that says `loaded`, `document-start` and `document-end`, as Electron's does. Slack's preload threw without it and never exposed its `desktop` bridge.
