---
"domicile": patch
"@domicile-desktop/distro": minor
---

- NixOS: the system build fails, saying how to fix it, when Domicile cannot load the system's graphics driver (a driver from a newer nixpkgs). Fix: `inputs.domicile.inputs.nixpkgs.follows = "nixpkgs";`.
- The compositor reports a failed EGL renderer as an error, with an urgent "Graphics aren't working" notification; each render node libgbm refuses is logged with its reason.
