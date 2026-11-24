---
"@domicile-desktop/ci": patch
"domicile": patch
---

The flake serves Domicile from a binary cache at `https://packages.domicile-desktop.com/nix`, filled for each commit `stable` moves to, so `nix run` and configs pinned to `stable` download Domicile instead of building it.
