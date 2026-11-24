---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
---

`domicile open --profile <id> <url>` opens a link in that browser profile, and a link opened without one goes to its site's profile instead of always the default one. The SDK's `browser` gains `profiles`, a `profilesChange` event, `profileFor(url)`, `reopen(id, profile)` and a `profile` option on `open`.
