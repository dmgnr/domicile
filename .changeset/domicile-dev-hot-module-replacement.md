---
"@domicile-desktop/builder": minor
"@domicile-desktop/engine": minor
"domicile": minor
---

`domicile dev <entry>` serves a shell from its source with hot module replacement: an edit applies as you save, and with React Fast Refresh the shell keeps its state. Ctrl-C goes back to the shell it replaced. The engine reaches the builder's Vite dev server over a private socket, so no port opens.
