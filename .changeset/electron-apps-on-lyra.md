---
"domicile": patch
"@domicile-desktop/electron-host": patch
---

Electron apps start on the engine more reliably:

- Apps started at login wait up to a minute for the engine instead of failing at once.
- An app whose package removed some of its unpacked files (nixpkgs' ChatGPT) starts.
- safeStorage picks its backend the way Chromium does, from `--password-store` and the desktop, so Element no longer migrates its store and relaunches forever. `app.commandLine` now answers the switches the app was started with.
- `session.allowNTLMCredentialsForDomains` is accepted, and Slack's `slack-webapp-dev` and ChatGPT's `codex-sandbox` schemes register from the engine's first start, so neither falls back on its first run.
