---
"domicile": patch
"@domicile-desktop/sdk": patch
---

`domicile sleep-displays <name>`, `wake-displays <name>` and a shell's per-display white point find a monitor by any name a profile matches: its connector (`eDP-1`), its panel (`BOE NE135A1M-NY1`) or its output name (`drm-<id>`). Before, a monitor with an EDID name answered only to `drm-<id>`. A name that matches no display, or several, fails listing every display's names. Profiles also match a monitor by its connector.
