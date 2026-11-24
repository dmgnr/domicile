---
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": major
"@domicile-desktop/manganese": minor
"@domicile-desktop/e2e-harness": patch
---

`domicile exec <program> [<arg>...]` and the SDK's `KeyAction.Exec` start a program for any shell, found on the desktop's `PATH`, and say why when it does not start; a key's failed start is a notification. Manganese's `exec` command is gone: its `exec()` builds `KeyAction.Exec`. `domicile drag` replaces `pointer press`/`release`, which let go as each command ended, and `domicile type` presses Return for a line break. The MCP server gains an `exec` tool, and its `drag` holds the button.
