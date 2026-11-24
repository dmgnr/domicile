---
"domicile": minor
"@domicile-desktop/sdk": major
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/manganese": minor
"@domicile-desktop/e2e-harness": patch
"@domicile-desktop/engine": patch
---

`domicile list-bindings` prints the running shell's keys and gestures in each
binding mode and what they run. A shell command can now answer, and
`domicile send-shell` prints the answer: Manganese's `get-workspaces` and
`get-tree` answer with JSON, as `swaymsg -t get_workspaces` and `get_tree` do.

Breaking: `onCommand` may return `Ok({ output })`;
`shell.commands(help, bindings)` takes the bindings, which `bindKeys`
describes for you; and `shell.answer(sent, ran)` takes the command's `Result`.
