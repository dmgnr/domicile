---
"domicile": patch
"@domicile-desktop/electron-host": patch
---

ChatGPT opens again. It refuses to start on anything but OpenAI's own Electron fork, so `electron-host` hands it back to its own Electron before its main runs, with a notification saying so.
