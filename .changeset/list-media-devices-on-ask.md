---
"@domicile-desktop/engine": patch
"domicile": patch
---

The engine lists cameras and microphones on the first ask instead of at startup, and answers that ask once they are listed. Chrome's dictation, which listed microphones as each tab opened, stays off. An idle desktop no longer runs Chromium's audio service (~35 MiB).
