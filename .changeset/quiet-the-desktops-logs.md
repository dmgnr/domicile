---
"domicile": patch
"@domicile-desktop/engine": patch
---

The desktop's logs are quiet by default again. Turning up one subsystem shows only that subsystem's engine lines, not every engine file's. Pages' and extensions' consoles appear only when everything is turned up. Apps the desktop starts log under their own names at `info` instead of as the compositor's errors, and the web-agent relay under `domicile-relay`. The engine no longer turns on a V8 flag its V8 rejects, which wrote "unrecognized flag" hundreds of times a boot. A broken unpacked extension is reported once, not once per profile and reload. Chromium's fallback art for the hidden pointer is no longer reported as an error.
