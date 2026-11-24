---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app's downloads go where its session's `will-download` says, and its `DownloadItem` hears how they go, so Slack's downloads save instead of sitting as hidden temporary files.
