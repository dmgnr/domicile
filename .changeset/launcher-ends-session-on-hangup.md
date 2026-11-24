---
"domicile": patch
---

The launcher treats `SIGHUP` as a stop: logging out of a tty login ends the graphical session, so units bound to `graphical-session.target` stop with the desk.
