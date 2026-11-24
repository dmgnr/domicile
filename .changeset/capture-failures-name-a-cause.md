---
"@domicile-desktop/engine": patch
"domicile": patch
---

A screenshot or screen cast the engine can't capture now fails at once with the cause, instead of timing out. Nested in a Wayland session whose GPU can't make dmabufs, captures now come in shared memory, so `domicile screenshot` works there.
