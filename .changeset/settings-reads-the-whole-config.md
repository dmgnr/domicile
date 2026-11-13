---
"@domicile-desktop/app-settings": patch
"@domicile-desktop/sdk": minor
"domicile": patch
---

Settings reads every key the compositor reads, such as `input.mouse`, `input.touchpad` and `terminal`, instead of refusing the config. Its schema is now `@domicile-desktop/sdk/config-schema`, a Zod schema generated from the compositor's config with its defaults filled in.
