---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app's sandboxed preload gets `process.versions.electron` and `process.resourcesPath`, which the host now sends in `hello` for every page, not only Node's. `webFrame.insertText` types at the page's focus, `webFrame.setVisualZoomLevelLimits` sets pinch zoom's limits, and the rest of Electron's renderer `process` (`contextId`, and calls such as `getCPUUsage` that say they don't work yet) is there, so a preload no longer finds `undefined` where Electron has an API.
