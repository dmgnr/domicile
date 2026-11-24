---
"@domicile-desktop/engine": minor
"domicile": minor
---

Shells and app modules are now cross-origin isolated, with no COOP or COEP headers: `crossOriginIsolated` is true and `SharedArrayBuffer` works, so threaded wasm and tools like the TypeScript language service run. Nothing they load is checked for CORP. Pages in a `<webview>` are unchanged.
