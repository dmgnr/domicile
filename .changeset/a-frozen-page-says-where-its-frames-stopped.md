---
"@domicile-desktop/engine": patch
"domicile": patch
---

The engine's logs for a page stuck at an old size say more about where its frames stopped: where its tiles' raster tasks are (queued, running, finished but never collected, or waiting on an image decode), what its scheduler is waiting on, and, when it gets no begin frames, why the GPU process sends it none.
