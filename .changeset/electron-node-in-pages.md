---
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
"domicile": minor
---

Electron apps whose windows ask for Node.js in their pages (`nodeIntegration`, or `sandbox: false`) now run on Domicile's engine instead of falling back to their own Electron. Such a page gets its own unsandboxed renderer with Electron's Node in it, as Electron gives it; every other page stays sandboxed.
