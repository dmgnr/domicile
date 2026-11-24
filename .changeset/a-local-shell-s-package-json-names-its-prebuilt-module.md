---
"domicile": minor
---

A local shell's `package.json` can name its prebuilt module, as a package's does: `"domicile": { "shell": "dist/shell.js" }`. `domicile ./my-desktop` serves it, and a module named there is never sent to the builder.
