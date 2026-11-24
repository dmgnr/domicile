---
"domicile": patch
"@domicile-desktop/distro": patch
---

Electron apps' clipboard and link handlers work without `wl-clipboard` or `xdg-utils` installed: Nix puts both on `electron-host`'s `PATH`, and distribution packages recommend them.
