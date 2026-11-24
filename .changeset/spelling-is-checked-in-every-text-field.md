---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/e2e-harness": patch
"@domicile-desktop/distro": minor
"@domicile-desktop/ci": patch
"domicile": minor
---

Text fields in pages, web apps and Electron apps check spelling, in American English unless the config's `spellcheck.languages` says otherwise. The dictionaries ship with the engine and are never downloaded. A context menu event over a misspelled word carries `misspelledWord`, `spellingSuggestions` and `replaceMisspelling()`, and runs `add-to-dictionary`; manganese puts the suggestions at the top of the field's menu.
