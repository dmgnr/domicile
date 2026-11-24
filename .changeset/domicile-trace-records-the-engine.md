---
"domicile": patch
---

`domicile trace <file>` records the engine's trace events (frame production in the shell and pages, the display compositor, GPU and page flips) to a Perfetto trace. The engine reports to a socket beside the control socket, where `domicile trace` runs Perfetto's service while it records.
