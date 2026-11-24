---
"@domicile-desktop/e2e-harness": patch
"@domicile-desktop/sdk": patch
"domicile": patch
---

A page's `mailto:` link reaches the shell that claims `mailto:`, such as manganese's inbox picker. Chromium opens these links with `xdg-email`, and a desktop's `xdg-email` is `domicile-xdg-email`, which runs `domicile open` on the link its arguments make.
