---
"@domicile-desktop/sdk": minor
"@domicile-desktop/engine": patch
"domicile": patch
---

A shell's console messages keep their severity in the desktop's logs, so its errors show by default and `console.debug` shows at `domicile set-log-level debug shell`. `logger(subsystem)` from `@domicile-desktop/sdk/logger` names the part of the shell that said each line, filed as `DOMICILE_SUBSYSTEM` in the journal.
