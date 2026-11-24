---
"domicile": patch
---

Correct why the launcher catches `SIGHUP`: every logout sends it, not only a tty hangup.
