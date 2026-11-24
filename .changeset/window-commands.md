---
"domicile": minor
"@domicile-desktop/e2e-harness": patch
---

Add `domicile lock`, `focus-window <id>`, `close-window <id>`, `kill-window <id>` and `inhibit-idle -- <command>`. The window commands take the ids `list-windows` prints. `focus-window` asks the shell to show and focus the window, the same request an app's activation makes. `inhibit-idle` keeps the screens on until the command exits.
