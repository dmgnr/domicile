---
"@domicile-desktop/engine": patch
"@domicile-desktop/electron-host": patch
"domicile": patch
---

An Electron app hears its pages' `login`, `certificate-error` and `select-client-certificate` and answers them, and a `ClientRequest` hears `login`; a sign-in no listener takes still asks through the shell. Sessions gain `clearData`, `clearAuthCache`, `clearCodeCaches`, `resolveHost`, a working `preconnect`, `getStoragePath` and `storagePath`, the shared dictionary calls, `registerPreloadScript` and its kin, and a `serviceWorkers` that knows the running workers and fires their events.
