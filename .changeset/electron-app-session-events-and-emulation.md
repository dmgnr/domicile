---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app's sessions fire `preconnect` and `spellcheck-dictionary-initialized`, emulate network conditions with `enableNetworkEmulation`, and keep their code cache where `setCodeCachePath` says. The app fires `gpu-info-update`, and has Electron's main-process `WebSocket` and `contentTracing.enableHeapProfiling`.
