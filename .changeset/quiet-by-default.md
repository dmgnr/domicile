---
"domicile": minor
---

Quiet by default: the compositor and the launcher log errors alone, and a desktop says one `domicile is up.` line with what it chose and its control socket (`DOMICILE_SOCK=` at its end), and `domicile is down:` when it ends cleanly. `domicile set-log-level` turns them up.
