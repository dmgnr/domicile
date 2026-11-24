---
"@domicile-desktop/engine": patch
"domicile": patch
---

- The engine's GPU process loads Mesa's GBM backends and DRI drivers before its sandbox, so a card handed over later finds the libraries they link. On NixOS, LLVM was refused ("libLLVM.so.21.1: Permission denied") and the card showed only software output.
- A driver that does not load logs the loader's reason as an error.
