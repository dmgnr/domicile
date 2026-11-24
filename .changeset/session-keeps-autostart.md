---
"domicile": patch
---

`~/.config/autostart` entries start again with a Domicile session. The session target and the autostart target formed an ordering cycle, which systemd broke by skipping every autostart entry, the keyring's among them.
