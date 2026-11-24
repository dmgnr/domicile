---
"domicile": minor
"@domicile-desktop/sdk": major
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/shell-simple": patch
"@domicile-desktop/e2e-harness": patch
"@domicile-desktop/engine": patch
---

`domicile list-shell-commands` (also `send-shell --help`) prints the commands
`send-shell` takes, as the running shell describes them. `send-shell` now fails
with the shell's reason when the shell refuses a command or never says it ran
it, instead of always succeeding.

Breaking: `bindKeys` takes `commands`, describing what `onCommand` runs, and
`onCommand` returns `Ok("ran")` or `Err(reason)`. `shell.commands(help)`
replaces listening without a description, and `shell.answer(sent, refused)`
reports how each command ended. Manganese describes all of its commands.
